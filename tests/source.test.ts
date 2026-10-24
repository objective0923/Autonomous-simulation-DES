import { describe, expect, it } from "vitest";
import { createExampleProject } from "../src/examples";
import {
  applyDrawingSource,
  confirmSourceCalibration,
  dimensionCandidates,
  inspectDrawingBytes,
  MAX_SOURCE_BYTES,
  metersPerPixel,
  referenceDistance,
  renderSize,
  updateSourceCalibration,
  validateSourceFile,
} from "../src/source";

const drawing = {
  name: "고객 평면도.png",
  type: "image" as const,
  page: 1,
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  widthPx: 1000,
  heightPx: 500,
};
function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("local customer drawing import", () => {
  it("accepts declared local PDF and raster files and rejects empty, oversized and unsupported inputs", () => {
    expect(() =>
      validateSourceFile({
        name: "floor.pdf",
        type: "application/pdf",
        size: 10,
      }),
    ).not.toThrow();
    expect(() =>
      validateSourceFile({ name: "floor.JPG", type: "", size: 10 }),
    ).not.toThrow();
    expect(() =>
      validateSourceFile({
        name: "floor.pdf",
        type: "application/pdf",
        size: 0,
      }),
    ).toThrow("빈 파일");
    expect(() =>
      validateSourceFile({
        name: "floor.png",
        type: "image/png",
        size: MAX_SOURCE_BYTES + 1,
      }),
    ).toThrow("20 MiB");
    expect(() =>
      validateSourceFile({
        name: "floor.svg",
        type: "image/svg+xml",
        size: 100,
      }),
    ).toThrow("PNG");
  });
  it("inspects real file signatures, image dimensions and allocation limits before decoding", () => {
    expect(inspectDrawingBytes(pngHeader(2400, 1200))).toEqual({
      type: "image",
      width: 2400,
      height: 1200,
    });
    expect(() => inspectDrawingBytes(pngHeader(30000, 30000))).toThrow("화소");
    expect(() =>
      inspectDrawingBytes(new TextEncoder().encode("not a drawing")),
    ).toThrow("일치");
    expect(inspectDrawingBytes(new TextEncoder().encode("%PDF-1.7\n"))).toEqual(
      { type: "pdf" },
    );
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 100, 0, 200, 1,
    ]);
    expect(inspectDrawingBytes(jpeg)).toEqual({
      type: "image",
      width: 200,
      height: 100,
    });
  });
  it("caps rendered drawing dimensions and area while retaining the aspect ratio", () => {
    const output = renderSize(12000, 6000);
    expect(output.width).toBeLessThanOrEqual(4096);
    expect(output.width * output.height).toBeLessThanOrEqual(12_000_000);
    expect(output.width / output.height).toBeCloseTo(2, 2);
  });
  it("keeps a selected PDF page as a local raster and rejects invalid page metadata", () => {
    const result = applyDrawingSource(createExampleProject(), {
      ...drawing,
      type: "pdf",
      page: 3,
    });
    expect(result.spacePlan?.source?.page).toBe(3);
    expect(result.background?.dataUrl).toBe(drawing.dataUrl);
    expect(() =>
      applyDrawingSource(result, { ...drawing, type: "pdf", page: 101 }),
    ).toThrow("페이지");
  });
});

describe("drawing scale and explicit verification", () => {
  it("maps a 500 px reference to 10 m and applies the same scale to both axes without mutating the original", () => {
    const original = createExampleProject(),
      imported = applyDrawingSource(original, drawing);
    const distance = referenceDistance({ x: 100, y: 100 }, { x: 400, y: 500 });
    expect(distance).toBe(500);
    expect(metersPerPixel(distance, 10)).toBe(0.02);
    const calibrated = updateSourceCalibration(imported, {
      referencePixels: distance,
      referenceMeters: 10,
    });
    expect(calibrated.background?.width).toBe(20);
    expect(calibrated.background?.height).toBe(10);
    expect(calibrated.spacePlan?.calibration.confirmed).toBe(false);
    expect(original.spacePlan?.source).toBeUndefined();
  });
  it("requires usable references and nonempty evidence before explicit confirmation", () => {
    const imported = applyDrawingSource(createExampleProject(), drawing);
    expect(() => confirmSourceCalibration(imported, true)).toThrow("근거");
    let calibrated = updateSourceCalibration(imported, {
      referencePixels: 500,
      referenceMeters: 10,
      evidence: "고객 도면 A-01의 10,000 mm 치수선",
    });
    calibrated = confirmSourceCalibration(calibrated, true);
    expect(calibrated.spacePlan?.calibration.confirmed).toBe(true);
    expect(() => referenceDistance({ x: 1, y: 1 }, { x: 1, y: 1 })).toThrow(
      "2 px",
    );
    expect(() => metersPerPixel(500, 0)).toThrow("기준거리");
  });
  it("invalidates source scale and building confirmation whenever the source or scale evidence changes", () => {
    let project = updateSourceCalibration(
      applyDrawingSource(createExampleProject(), drawing),
      { referencePixels: 500, referenceMeters: 10, evidence: "확인 근거" },
    );
    project = confirmSourceCalibration(project, true);
    project.spacePlan!.building.confirmed = true;
    project.spacePlan!.layout.placements = [
      { id: "old-layout", x: 1, y: 1, width: 1, depth: 1, rotation: 0 },
    ];
    const changed = updateSourceCalibration(project, { referenceMeters: 12 });
    expect(changed.spacePlan?.calibration.confirmed).toBe(false);
    expect(changed.spacePlan?.building.confirmed).toBe(false);
    expect(changed.spacePlan?.layout.placements).toEqual([]);
    const replaced = applyDrawingSource(project, {
      ...drawing,
      name: "수정본.png",
    });
    expect(replaced.spacePlan?.calibration.referenceMeters).toBeNull();
    expect(replaced.spacePlan?.calibration.confirmed).toBe(false);
    expect(replaced.spacePlan?.building.confirmed).toBe(false);
    expect(replaced.spacePlan?.layout.placements).toEqual([]);
    const edited = updateSourceCalibration(project, {
      evidence: "다른 도면 참조",
    });
    expect(edited.spacePlan?.calibration.confirmed).toBe(false);
  });
  it("extracts text hints only when explicit units are present and deduplicates the hints", () => {
    expect(
      dimensionCandidates("BAY 10000 · 10,000 mm · 10,000 mm · 3.5m · 42"),
    ).toEqual(["10,000 mm", "3.5m"]);
    expect(dimensionCandidates("100 m² · 200 m3 · 5 m")).toEqual(["5 m"]);
  });
  it("preserves selected source-pixel endpoints with saved calibration and clears them when the reference is reset", () => {
    const imported = applyDrawingSource(createExampleProject(), drawing);
    const calibrated = updateSourceCalibration(imported, {
      referencePixels: 500,
      referenceMeters: 10,
      points: [
        { x: 100, y: 100 },
        { x: 400, y: 500 },
      ],
    });
    expect(
      JSON.parse(JSON.stringify(calibrated)).spacePlan.calibration.points,
    ).toEqual([
      { x: 100, y: 100 },
      { x: 400, y: 500 },
    ]);
    expect(
      updateSourceCalibration(calibrated, { referencePixels: null }).spacePlan
        ?.calibration.points,
    ).toBeUndefined();
  });
});
