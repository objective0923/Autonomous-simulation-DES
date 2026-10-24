import { describe, expect, it } from "vitest";
import { createSpacePlan, generateLayout } from "../src/planning";
import type { MapObject, SpacePlan } from "../src/types";

const EPS = 1e-8;
const fixture = (): SpacePlan => {
  const p = createSpacePlan();
  p.source = {
    name: "검증 도면.png",
    type: "image",
    page: 1,
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    widthPx: 4000,
    heightPx: 2400,
  };
  p.calibration = {
    referencePixels: 100,
    referenceMeters: 1,
    confirmed: true,
    evidence: "도면 기준선 100 px = 1 m 확인",
  };
  p.building = {
    width: 40,
    depth: 24,
    clearHeight: 9,
    confirmed: true,
    evidence: "건물 실측치 및 유효높이 기록",
  };
  p.robot = {
    ...p.robot,
    kind: "ctu",
    width: 0.85,
    length: 1.15,
    minAisleWidth: 2,
    minTransferHeight: 0,
    maxLiftHeight: 7,
    overallHeight: 7.5,
    maxPayloadKg: 500,
    confirmed: true,
    evidence: "시험용 제조사 치수표",
  };
  p.rack.confirmed = true;
  p.rack.evidence = "시험용 랙 하중 및 선반 치수표";
  p.layout.margin = 0.6;
  p.layout.crossAisle = 2.5;
  return p;
};

type Placement = SpacePlan["layout"]["placements"][number];
function bounds(p: Placement) {
  const width = p.rotation === 90 ? p.depth : p.width;
  const height = p.rotation === 90 ? p.width : p.depth;
  return {
    left: p.x - width / 2,
    right: p.x + width / 2,
    top: p.y - height / 2,
    bottom: p.y + height / 2,
  };
}
function overlaps(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) {
  return (
    a.left < b.right - EPS &&
    a.right > b.left + EPS &&
    a.top < b.bottom - EPS &&
    a.bottom > b.top + EPS
  );
}

describe("automatic layout geometry and evidence limits", () => {
  it("refuses unknown real robot footprints rather than borrowing demo robot specifications", () => {
    const p = createSpacePlan();
    expect(p.robot.width).toBeNull();
    expect(p.robot.length).toBeNull();
    expect(p.robot.minAisleWidth).toBeNull();
    const r = generateLayout(p, []);
    expect(r.placements).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.status).toBe("provisional");
  });

  it("generates deterministic, distinct, bounded and nonoverlapping rack placements", () => {
    const p = fixture();
    const inputBefore = structuredClone(p);
    const a = generateLayout(p, []);
    const b = generateLayout(p, []);
    expect(a).toEqual(b);
    expect(p).toEqual(inputBefore);
    expect(a.placements.length).toBeGreaterThan(0);
    expect(a.candidateCount).toBeGreaterThanOrEqual(2);
    expect(new Set(a.placements.map((x) => x.id)).size).toBe(
      a.placements.length,
    );
    for (const [i, placement] of a.placements.entries()) {
      const box = bounds(placement);
      expect(box.left).toBeGreaterThanOrEqual(p.layout.margin - EPS);
      expect(box.top).toBeGreaterThanOrEqual(p.layout.margin - EPS);
      expect(box.right).toBeLessThanOrEqual(
        p.building.width - p.layout.margin + EPS,
      );
      expect(box.bottom).toBeLessThanOrEqual(
        p.building.depth - p.layout.margin + EPS,
      );
      for (const other of a.placements.slice(i + 1))
        expect(overlaps(box, bounds(other))).toBe(false);
    }
    expect(a.capacity5).toBe(a.placements.length * 5);
    expect(a.capacity6).toBe(a.placements.length * 6);
    expect(a.assumptions.length).toBeGreaterThan(0);
  });

  it("excludes a rotated column and its conservative half-aisle clearance", () => {
    const p = fixture();
    const column: MapObject = {
      id: "column",
      name: "회전 기둥",
      kind: "column",
      x: 20,
      y: 12,
      width: 3,
      height: 2,
      rotation: 45,
    };
    const r = generateLayout(p, [column]);
    const rad = Math.PI / 4;
    const halfWidth =
      (Math.abs(Math.cos(rad)) * column.width +
        Math.abs(Math.sin(rad)) * column.height) /
        2 +
      p.robot.minAisleWidth! / 2;
    const halfHeight =
      (Math.abs(Math.sin(rad)) * column.width +
        Math.abs(Math.cos(rad)) * column.height) /
        2 +
      p.robot.minAisleWidth! / 2;
    const excluded = {
      left: column.x - halfWidth,
      right: column.x + halfWidth,
      top: column.y - halfHeight,
      bottom: column.y + halfHeight,
    };
    expect(r.placements.length).toBeGreaterThan(0);
    for (const placement of r.placements)
      expect(overlaps(bounds(placement), excluded)).toBe(false);
  });

  it("treats occupied line and wall footprints as exclusion areas", () => {
    const p = fixture();
    const allFloor: MapObject = {
      id: "occupied",
      name: "전체 설비 점유",
      kind: "line",
      x: 20,
      y: 12,
      width: 40,
      height: 24,
      rotation: 0,
    };
    expect(generateLayout(p, [allFloor]).placements).toEqual([]);
    expect(
      generateLayout(p, [{ ...allFloor, kind: "wall" }]).placements,
    ).toEqual([]);
  });

  it("rejects aisles narrower than the robot footprint, turning envelope or cross-aisle access", () => {
    for (const width of [0.5, 1]) {
      const p = fixture();
      p.robot.minAisleWidth = width;
      const r = generateLayout(p, []);
      expect(r.placements).toEqual([]);
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.status).toBe("provisional");
    }
    const p = fixture();
    p.layout.crossAisle = 1.8;
    const r = generateLayout(p, []);
    expect(r.placements).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("considers the rotated rack orientation on a narrow, deep building", () => {
    const p = fixture();
    p.building.width = 6.2;
    p.building.depth = 12.2;
    p.rack.width = 4;
    p.rack.depth = 1.5;
    p.layout.margin = 0.1;
    p.layout.crossAisle = 2;
    const r = generateLayout(p, []);
    expect(r.orientation).toBe(90);
    expect(r.placements.length).toBeGreaterThan(0);
    expect(r.placements.every((x) => x.rotation === 90)).toBe(true);
  });

  it("cannot label a plan verified when confirmation lacks actual evidence", () => {
    const p = fixture();
    expect(generateLayout(p, []).status).toBe("verified");
    for (const section of [
      "calibration",
      "building",
      "robot",
      "rack",
    ] as const) {
      const missingEvidence = structuredClone(p);
      missingEvidence[section].evidence = "   ";
      expect(generateLayout(missingEvidence, []).status).toBe("provisional");
      const unconfirmed = structuredClone(p);
      unconfirmed[section].confirmed = false;
      expect(generateLayout(unconfirmed, []).status).toBe("provisional");
    }
    delete p.source;
    expect(generateLayout(p, []).status).toBe("provisional");
  });
});
