import { createSpacePlan } from "./planning";
import type { Project, SpacePlan } from "./types";

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_DECODE_PIXELS = 64_000_000;
export const MAX_RENDER_PIXELS = 12_000_000;
export const MAX_RENDER_DIMENSION = 4096;
export const MAX_SOURCE_DATA_URL = 16 * 1024 * 1024;
export type SourcePoint = { x: number; y: number };
export type DrawingSource = NonNullable<SpacePlan["source"]>;

export function validateSourceFile(file: {
  name: string;
  size: number;
  type: string;
}): void {
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    throw new Error("빈 파일은 불러올 수 없습니다.");
  if (file.size > MAX_SOURCE_BYTES)
    throw new Error(
      "원본 파일은 20 MiB 이하로 준비해 주세요. 필요한 페이지만 별도로 저장할 수 있습니다.",
    );
  const extension = /\.(png|jpe?g|pdf)$/i.exec(file.name)?.[1].toLowerCase();
  if (
    !extension ||
    (file.type &&
      ![
        "image/png",
        "image/jpeg",
        "application/pdf",
        "application/octet-stream",
      ].includes(file.type))
  )
    throw new Error("PNG, JPG 또는 PDF 파일을 선택해 주세요.");
}

/** Inspect before browser decoding so tiny files cannot request huge raster allocations. */
export function inspectDrawingBytes(bytes: Uint8Array): {
  type: "image" | "pdf";
  width?: number;
  height?: number;
} {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length >= 24 &&
    png.every((value, index) => bytes[index] === value) &&
    String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR"
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16),
      height = view.getUint32(20);
    checkRasterSize(width, height);
    return { type: "image", width, height };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let index = 2;
    while (index < bytes.length) {
      if (bytes[index++] !== 0xff) break;
      while (bytes[index] === 0xff) index++;
      const marker = bytes[index++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (index + 1 >= bytes.length) break;
      const length = bytes[index] * 256 + bytes[index + 1];
      if (length < 2 || index + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 8
      ) {
        const height = bytes[index + 3] * 256 + bytes[index + 4],
          width = bytes[index + 5] * 256 + bytes[index + 6];
        checkRasterSize(width, height);
        return { type: "image", width, height };
      }
      index += length;
    }
    throw new Error(
      "JPG 크기 정보를 읽을 수 없습니다. 일반 JPG로 다시 저장해 주세요.",
    );
  }
  const header = String.fromCharCode(
    ...bytes.subarray(0, Math.min(bytes.length, 1024)),
  );
  if (header.includes("%PDF-")) return { type: "pdf" };
  throw new Error("파일 내용이 지원되는 PNG/JPG/PDF 형식과 일치하지 않습니다.");
}

export function checkRasterSize(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 32768 ||
    height > 32768 ||
    width * height > MAX_DECODE_PIXELS
  )
    throw new Error(
      "이미지는 가로·세로 32,768 px 이내, 총 6,400만 화소 이내여야 합니다. 축소 후 다시 선택해 주세요.",
    );
}

export function renderSize(
  width: number,
  height: number,
  preferredScale = 1,
): { width: number; height: number; scale: number } {
  if (
    ![width, height, preferredScale].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    preferredScale <= 0
  )
    throw new Error("도면의 가로·세로 크기를 확인할 수 없습니다.");
  const scale = Math.min(
    preferredScale,
    MAX_RENDER_DIMENSION / width,
    MAX_RENDER_DIMENSION / height,
    Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

export function referenceDistance(a: SourcePoint, b: SourcePoint): number {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite))
    throw new Error("기준점 좌표가 올바르지 않습니다.");
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance < 2)
    throw new Error(
      "기준점을 2 px 이상 떨어뜨려 선택해 주세요. 긴 기준선을 사용할수록 오차가 줄어듭니다.",
    );
  return distance;
}

export function metersPerPixel(
  referencePixels: number | null,
  referenceMeters: number | null,
): number {
  if (
    referencePixels === null ||
    referenceMeters === null ||
    !Number.isFinite(referencePixels) ||
    !Number.isFinite(referenceMeters) ||
    referencePixels < 2 ||
    referenceMeters <= 0
  )
    throw new Error(
      "기준점 2개의 거리(2 px 이상)와 실제 기준거리(m)를 입력해 주세요.",
    );
  const value = referenceMeters / referencePixels;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("축척을 계산할 수 없습니다.");
  return value;
}

export function applyDrawingSource(
  project: Project,
  source: DrawingSource,
): Project {
  if (
    !source.name.trim() ||
    !["image", "pdf"].includes(source.type) ||
    !Number.isSafeInteger(source.page) ||
    source.page < 1 ||
    source.page > MAX_PDF_PAGES ||
    (source.type === "image" && source.page !== 1)
  )
    throw new Error("원본 이름·형식·페이지를 확인해 주세요.");
  if (
    !/^data:image\/(png|jpeg);base64,/.test(source.dataUrl) ||
    source.dataUrl.length > MAX_SOURCE_DATA_URL
  )
    throw new Error(
      "저장 이미지가 너무 크거나 지원되지 않습니다. 도면 해상도를 낮춰 주세요.",
    );
  checkRasterSize(source.widthPx, source.heightPx);
  const next = structuredClone(project),
    plan = next.spacePlan ?? createSpacePlan();
  next.spacePlan = plan;
  plan.source = structuredClone(source);
  plan.calibration = {
    referencePixels: null,
    referenceMeters: null,
    confirmed: false,
    evidence: "",
  };
  plan.building.confirmed = false;
  plan.layout.placements = [];
  const width = next.background?.width ?? source.widthPx / 100;
  next.background = {
    dataUrl: source.dataUrl,
    x: next.background?.x ?? 0,
    y: next.background?.y ?? 0,
    width,
    height: (width * source.heightPx) / source.widthPx,
    opacity: next.background?.opacity ?? 0.55,
  };
  return next;
}

export function updateSourceCalibration(
  project: Project,
  patch: Partial<SpacePlan["calibration"]>,
): Project {
  const next = structuredClone(project),
    plan = next.spacePlan ?? createSpacePlan();
  next.spacePlan = plan;
  plan.calibration = { ...plan.calibration, ...patch, confirmed: false };
  if ("referencePixels" in patch && !("points" in patch))
    delete plan.calibration.points;
  plan.building.confirmed = false;
  plan.layout.placements = [];
  const { referencePixels, referenceMeters } = plan.calibration;
  if (
    plan.source &&
    referencePixels !== null &&
    referencePixels >= 2 &&
    referenceMeters !== null &&
    referenceMeters > 0
  ) {
    const scale = metersPerPixel(referencePixels, referenceMeters);
    next.background = {
      dataUrl: plan.source.dataUrl,
      x: next.background?.x ?? 0,
      y: next.background?.y ?? 0,
      width: plan.source.widthPx * scale,
      height: plan.source.heightPx * scale,
      opacity: next.background?.opacity ?? 0.55,
    };
  }
  return next;
}

export function confirmSourceCalibration(
  project: Project,
  confirmed: boolean,
): Project {
  const next = structuredClone(project),
    plan = next.spacePlan ?? createSpacePlan();
  next.spacePlan = plan;
  if (confirmed) {
    if (!plan.source || !plan.calibration.evidence.trim())
      throw new Error(
        "원본 도면과 기준거리의 확인 근거를 입력한 뒤 확인해 주세요.",
      );
    metersPerPixel(
      plan.calibration.referencePixels,
      plan.calibration.referenceMeters,
    );
  }
  plan.calibration.confirmed = confirmed;
  return next;
}

export function dimensionCandidates(text: string): string[] {
  // Text-layer hints only; no OCR, geometry interpretation, unit guessing or verification.
  return [
    ...new Set(
      text.match(
        /(?:\d[\d,]*(?:\.\d+)?)\s*(?:mm|cm|m|㎜|㎝|미터|밀리미터)(?![A-Za-z0-9²³])/giu,
      ) ?? [],
    ),
  ].slice(0, 30);
}
