import { describe, expect, it } from "vitest";
import {
  compareRackLevels,
  createSpacePlan,
  generateLayout,
  resolveVerticalGeometry,
  validateSpacePlan,
  verticalCapacity,
} from "../src/planning";
import { createExampleProject } from "../src/examples";
import { parseProject, validateProject } from "../src/model";
import type { SpacePlan } from "../src/types";

function confirmedPlan(): SpacePlan {
  const p = createSpacePlan();
  p.source = {
    name: "고객 도면.pdf",
    type: "pdf",
    page: 2,
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    widthPx: 1000,
    heightPx: 800,
  };
  p.calibration = {
    referencePixels: 100,
    referenceMeters: 5,
    confirmed: true,
    evidence: "PDF 치수선 확인",
  };
  p.building = {
    width: 40,
    depth: 24,
    clearHeight: 6.5,
    confirmed: true,
    evidence: "고객 유효높이 확인",
  };
  p.robot = {
    ...p.robot,
    kind: "ctu",
    width: 0.9,
    length: 1.2,
    minAisleWidth: 2,
    minTransferHeight: 0,
    maxLiftHeight: 5.5,
    overallHeight: 6,
    maxPayloadKg: 400,
    confirmed: true,
    evidence: "제조사 사양서",
  };
  p.rack.confirmed = true;
  p.rack.evidence = "제조사 선반표";
  return p;
}

describe("rack five/six level dimensional comparison", () => {
  it("keeps real robot measurements unknown and draft assumptions unconfirmed", () => {
    const p = createSpacePlan();
    expect(validateSpacePlan(p)).toEqual([]);
    expect(p.robot.width).toBeNull();
    expect(p.robot.maxLiftHeight).toBeNull();
    expect(compareRackLevels(p).map((x) => x.status)).toEqual([
      "needsReview",
      "needsReview",
    ]);
  });
  it("calculates shelf, load, overhead and lifting clearance in meters", () => {
    const [five, six] = compareRackLevels(confirmedPlan());
    expect(five).toMatchObject({
      levels: 5,
      topShelfHeight: 4.85,
      topLoadHeight: 5.7,
      totalHeight: 5.95,
      requiredClearHeight: 6.25,
      requiredLiftHeight: 4.95,
      status: "pass",
    });
    expect(six).toMatchObject({
      levels: 6,
      topShelfHeight: 5.95,
      topLoadHeight: 6.8,
      totalHeight: 7.05,
      requiredClearHeight: 7.35,
      requiredLiftHeight: 6.05,
      status: "fail",
    });
    expect(
      six.checks.filter((x) => x.status === "fail").map((x) => x.code),
    ).toEqual(expect.arrayContaining(["CLEAR_HEIGHT", "LIFT_HEIGHT"]));
  });
  it("rejects insufficient shelf pitch, load ratings or robot payload even at five levels", () => {
    const p = confirmedPlan();
    p.rack.shelfPitch = 0.9;
    p.rack.shelfCapacityKg = 200;
    p.robot.maxPayloadKg = 200;
    expect(
      compareRackLevels(p)[0]
        .checks.filter((x) => x.status === "fail")
        .map((x) => x.code),
    ).toEqual(
      expect.arrayContaining(["SHELF_PITCH", "SHELF_LOAD", "ROBOT_PAYLOAD"]),
    );
  });
  it("does not pass high rack handoff for low-profile or pallet AMRs", () => {
    for (const kind of ["lowProfile", "pallet"] as const) {
      const p = confirmedPlan();
      p.robot.kind = kind;
      expect(compareRackLevels(p)[0].status).toBe("needsReview");
      expect(
        compareRackLevels(p)[0].checks.find(
          (x) => x.code === "EXTERNAL_HANDOFF",
        )?.status,
      ).toBe("needsReview");
    }
  });
  it("supports twenty levels and minimum handoff heights without inventing real robot specifications", () => {
    const p = confirmedPlan();
    p.layout.requestedLevels = 20;
    p.building.clearHeight = 30;
    p.robot.maxLiftHeight = 25;
    p.robot.overallHeight = 26;
    const comparisons = compareRackLevels(p);
    expect(comparisons.map((x) => x.levels)).toEqual([5, 6, 20]);
    const twenty = comparisons[2];
    expect(twenty.status).toBe("pass");
    expect(twenty.checks.filter((c) => c.code.startsWith("TIER_")).length).toBe(
      20,
    );
    p.robot.minTransferHeight = 0.6;
    expect(
      compareRackLevels(p, [20])[0].checks.find((c) => c.code === "TIER_1")
        ?.status,
    ).toBe("fail");
  });
  it("checks fixed robot shelf count and each shelf alignment while variable masts do not require matching pitches", () => {
    const p = confirmedPlan();
    p.robot.transferMode = "fixedLevels";
    p.robot.firstShelfHeight = 0.45;
    p.robot.shelfPitch = 1.1;
    p.robot.shelfCount = 5;
    expect(compareRackLevels(p, [5])[0].status).toBe("pass");
    p.robot.shelfPitch = 1.05;
    expect(
      compareRackLevels(p, [5])[0].checks.find((c) => c.code === "TIER_2")
        ?.status,
    ).toBe("fail");
    p.robot.transferMode = "liftRange";
    expect(compareRackLevels(p, [5])[0].status).toBe("pass");
    p.robot.transferMode = "fixedLevels";
    p.robot.shelfPitch = 1.1;
    p.robot.shelfCount = 4;
    expect(
      compareRackLevels(p, [5])[0].checks.find(
        (c) => c.code === "ROBOT_SHELF_COUNT",
      )?.status,
    ).toBe("fail");
  });
  it("regenerates old proposal outputs after the building boundary changes", () => {
    const p = confirmedPlan();
    p.layout.placements = [
      { id: "old-rack", x: 100, y: 100, width: 10, depth: 10, rotation: 0 },
    ];
    const proposal = generateLayout(p, []);
    expect(proposal.placements.length).toBeGreaterThan(0);
    expect(proposal.status).toBe("verified");
    expect(proposal.placements.every((r) => r.id !== "old-rack")).toBe(true);
  });
  it("uses the supplied structural model consistently for pitch, minimum and fixed total height modes", () => {
    const p = confirmedPlan();
    expect(resolveVerticalGeometry(p, 6)).toMatchObject({
      pitch: 1.1,
      totalHeight: 7.05,
      minPitch: 1,
      clearanceAbove: 0.2,
    });
    p.rack.heightMode = "minimum";
    expect(resolveVerticalGeometry(p, 6)).toMatchObject({
      pitch: 1,
      totalHeight: 6.45,
      clearanceAbove: 0.1,
    });
    p.rack.heightMode = "totalHeight";
    p.rack.totalHeight = 2.699;
    p.rack.firstShelfHeight = 0.15;
    p.rack.loadHeight = 0.3;
    p.rack.liftClearance = 0.07;
    expect(resolveVerticalGeometry(p, 6)).toMatchObject({
      pitch: 0.424833333,
      totalHeight: 2.699,
      minPitch: 0.42,
      topShelfHeight: 2.274166667,
    });
    expect(compareRackLevels(p, [6])[0].requiredClearHeight).toBe(2.999);
  });
  it("retains the supplied 2699 mm six-tier example and reports space needed for the next tier", () => {
    const p = confirmedPlan();
    p.layout.requestedLevels = 6;
    p.rack = {
      ...p.rack,
      firstShelfHeight: 0.15,
      loadHeight: 0.3,
      liftClearance: 0.07,
      beamThickness: 0.05,
      topClearance: 0.3,
      heightMode: "totalHeight",
      totalHeight: 2.699,
    };
    p.building.clearHeight = 3;
    p.robot = {
      ...p.robot,
      overallHeight: 3,
      minTransferHeight: 0.1,
      maxLiftHeight: 2.6,
    };
    expect(compareRackLevels(p, [6])[0].status).toBe("pass");
    expect(verticalCapacity(p)).toMatchObject({
      basis: "fixedTotalHeight",
      max: 6,
      byHeight: 6,
      byLift: 6,
      spaceHeightForNext: 3.39,
      workSurfaceMaxForNext: 2.67,
      liftHeightForNext: 2.74,
    });
  });
  it("cannot produce a compatible maximum when robot overall height exceeds the room or is unknown", () => {
    const p = confirmedPlan();
    p.building.clearHeight = 5.9;
    expect(verticalCapacity(p)).toMatchObject({
      byLift: 0,
      max: 0,
      basis: "fixedPitch",
    });
    expect(
      compareRackLevels(p, [1])[0].checks.find(
        (c) => c.code === "ROBOT_OVERALL",
      )?.status,
    ).toBe("fail");
    p.robot.overallHeight = null;
    p.robot.confirmed = false;
    expect(verticalCapacity(p).max).toBeNull();
    expect(compareRackLevels(p, [1])[0].status).toBe("needsReview");
  });
  it("requires source and explicit evidence before any comparison fully passes", () => {
    for (const key of ["calibration", "building", "robot", "rack"] as const) {
      const p = confirmedPlan();
      p[key].confirmed = false;
      expect(compareRackLevels(p)[0].status).toBe("needsReview");
    }
    const p = confirmedPlan();
    delete p.source;
    p.calibration.confirmed = false;
    expect(compareRackLevels(p)[0].status).toBe("needsReview");
  });
});

describe("planning metadata import validation", () => {
  it("rejects malformed nested structures without throwing", () => {
    for (const p of [
      null,
      [],
      {},
      { robot: null },
      { source: 1, calibration: [] },
    ]) {
      expect(() => validateSpacePlan(p)).not.toThrow();
      expect(validateSpacePlan(p).some((x) => x.severity === "error")).toBe(
        true,
      );
    }
  });
  it("rejects invented confirmation without evidence or measurements", () => {
    const p = createSpacePlan();
    p.robot.confirmed = true;
    p.building.confirmed = true;
    p.calibration.confirmed = true;
    expect(
      validateSpacePlan(p).filter((i) => i.code === "PLAN_FALSE_CONFIRMATION")
        .length,
    ).toBeGreaterThan(2);
  });
  it("applies supplied core validation to fully specified vertical inputs before saving a project", () => {
    const p = confirmedPlan();
    p.robot.maxLiftHeight = 0;
    p.robot.minTransferHeight = 0;
    expect(validateSpacePlan(p).map((i) => i.code)).toContain(
      "PLAN_VERTICAL_OUT_OF_RANGE",
    );
    p.robot.maxLiftHeight = 5.5;
    p.rack.heightMode = "totalHeight";
    p.rack.totalHeight = null;
    expect(validateSpacePlan(p).map((i) => i.code)).toContain(
      "PLAN_TOTAL_HEIGHT",
    );
  });
  it("validates selected PDF page metadata while retaining only a rendered raster", () => {
    const p = confirmedPlan();
    expect(validateSpacePlan(p)).toEqual([]);
    p.source!.dataUrl = "data:application/pdf;base64,JVBERg==";
    p.source!.page = 0;
    expect(validateSpacePlan(p).map((i) => i.code)).toEqual(
      expect.arrayContaining(["PLAN_SOURCE_IMAGE", "PLAN_SOURCE_PAGE"]),
    );
  });
  it("integrates optional metadata with project save/load and rejects inconsistent imported dimensions", () => {
    const p = createExampleProject();
    p.spacePlan = confirmedPlan();
    expect(parseProject(JSON.parse(JSON.stringify(p))).spacePlan).toEqual(
      p.spacePlan,
    );
    p.spacePlan.layout.placements = [
      { id: "rack-1", x: 100, y: 2, width: 1.2, depth: 1.1, rotation: 0 },
    ];
    expect(validateProject(p).map((i) => i.code)).toContain(
      "PLAN_OUT_OF_BOUNDS",
    );
    expect(() => parseProject(p)).toThrow();
  });
  it("preserves exact drawing reference endpoints and rejects malformed or inconsistent pixel geometry", () => {
    const p = createExampleProject();
    p.spacePlan = confirmedPlan();
    p.spacePlan.calibration.points = [
      { x: 100, y: 100 },
      { x: 160, y: 180 },
    ];
    expect(
      parseProject(JSON.parse(JSON.stringify(p))).spacePlan?.calibration.points,
    ).toEqual(p.spacePlan.calibration.points);
    const invalidPoints = [
      [{ x: 100, y: 100 }],
      [
        { x: -1, y: 100 },
        { x: 160, y: 180 },
      ],
      [
        { x: 100, y: 100 },
        { x: 1001, y: 180 },
      ],
      [
        { x: 100, y: 100 },
        { x: 160, y: NaN },
      ],
      [
        { x: 100, y: 100 },
        { x: 100, y: 100 },
      ],
      [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
    ];
    for (const points of invalidPoints) {
      const plan = {
        ...p.spacePlan,
        calibration: { ...p.spacePlan.calibration, confirmed: false, points },
      };
      expect(() => validateSpacePlan(plan)).not.toThrow();
      expect(
        validateSpacePlan(plan).some(
          (i) =>
            i.code.startsWith("PLAN_CALIBRATION_") && i.severity === "error",
        ),
      ).toBe(true);
    }
  });
});
