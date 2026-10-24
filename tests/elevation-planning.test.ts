import { describe, expect, it } from "vitest";
import {
  compareRackLevels,
  createSpacePlan,
  generateLayout,
  validateSpacePlan,
} from "../src/planning";
import { createExampleProject } from "../src/examples";
import { parseProject } from "../src/model";
import type { MapObject, SpacePlan } from "../src/types";

/** Independent dimensional fixture; these deliberately simple numbers are test assumptions. */
function twentyTierPlan(): SpacePlan {
  return {
    source: {
      name: "test-plan.png",
      type: "image",
      page: 1,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      widthPx: 1000,
      heightPx: 600,
    },
    calibration: {
      referencePixels: 100,
      referenceMeters: 4,
      confirmed: true,
      evidence: "Test reference dimension",
    },
    building: {
      width: 40,
      depth: 24,
      clearHeight: 25,
      confirmed: true,
      evidence: "Test clear envelope",
    },
    robot: {
      kind: "ctu",
      width: 1,
      length: 1.5,
      minAisleWidth: 2,
      overallHeight: 25,
      minTransferHeight: 0.3,
      maxLiftHeight: 25,
      firstShelfHeight: 0.5,
      shelfPitch: 1,
      shelfCount: 20,
      transferMode: "liftRange",
      alignmentTolerance: 0.005,
      maxPayloadKg: 500,
      confirmed: true,
      evidence: "Test robot dimensions",
    },
    rack: {
      width: 1.2,
      depth: 1,
      firstShelfHeight: 0.5,
      shelfPitch: 1,
      loadHeight: 0.5,
      topClearance: 0.3,
      liftClearance: 0.1,
      beamThickness: 0.05,
      heightMode: "pitch",
      totalHeight: null,
      unitLoadKg: 300,
      shelfCapacityKg: 500,
      confirmed: true,
      evidence: "Test rack dimensions",
    },
    layout: {
      margin: 0.6,
      crossAisle: 2.5,
      requestedLevels: 20,
      placements: [],
    },
  };
}

const comparison = (plan: SpacePlan, levels = plan.layout.requestedLevels) =>
  compareRackLevels(plan, [levels])[0];
const checkStatus = (plan: SpacePlan, code: string) =>
  comparison(plan).checks.find((check) => check.code === code)?.status;
const tiers = (plan: SpacePlan) =>
  comparison(plan).checks.filter((check) => /^TIER_\d+$/.test(check.code));
const EPS = 1e-8;
type Placement = SpacePlan["layout"]["placements"][number];
function placementBounds(placement: Placement) {
  const width = placement.rotation === 90 ? placement.depth : placement.width;
  const depth = placement.rotation === 90 ? placement.width : placement.depth;
  return {
    left: placement.x - width / 2,
    right: placement.x + width / 2,
    top: placement.y - depth / 2,
    bottom: placement.y + depth / 2,
  };
}
function intersects(
  a: ReturnType<typeof placementBounds>,
  b: ReturnType<typeof placementBounds>,
) {
  return (
    a.left < b.right - EPS &&
    a.right > b.left + EPS &&
    a.top < b.bottom - EPS &&
    a.bottom > b.top + EPS
  );
}

describe("arbitrary supported rack elevations", () => {
  it("calculates all 20 tiers, including the first shelf and independent load/lift clearances", () => {
    const plan = twentyTierPlan();
    expect(validateSpacePlan(plan)).toEqual([]);
    // The upper structural cap is included: H = .5 + 20 × 1 = 20.5 m.
    // Product top is independently 19.5 + .5 = 20 m; it is not rack total height.
    expect(comparison(plan)).toMatchObject({
      levels: 20,
      topShelfHeight: 19.5,
      topLoadHeight: 20,
      totalHeight: 20.5,
      requiredClearHeight: 20.8,
      requiredLiftHeight: 19.6,
      status: "pass",
    });
    expect(tiers(plan)).toHaveLength(20);
    expect(tiers(plan).every((tier) => tier.status === "pass")).toBe(true);
    expect(tiers(plan)[0].message).toContain("0.500");
    expect(tiers(plan)[19].message).toContain("19.500");
  });

  it("supports the documented 100-tier limit without clamping calculations to five or six tiers", () => {
    const plan = twentyTierPlan();
    plan.layout.requestedLevels = 100;
    plan.rack.shelfPitch = 0.2;
    plan.rack.loadHeight = 0.1;
    plan.rack.liftClearance = 0.05;
    plan.robot.shelfCount = 100;
    expect(validateSpacePlan(plan)).toEqual([]);
    expect(comparison(plan)).toMatchObject({
      levels: 100,
      topShelfHeight: 20.3,
      topLoadHeight: 20.4,
      totalHeight: 20.5,
      requiredClearHeight: 20.8,
      requiredLiftHeight: 20.35,
      status: "pass",
    });
    expect(tiers(plan)).toHaveLength(100);
    const proposal = generateLayout(plan, []);
    expect(proposal.levels).toBe(100);
    expect(proposal.capacityUnits).toBe(proposal.placements.length * 100);
  });

  it("includes the requested tier count once in the default comparison and preserves explicit choices", () => {
    const plan = twentyTierPlan();
    expect(compareRackLevels(plan).map((result) => result.levels)).toEqual([
      5, 6, 20,
    ]);
    plan.layout.requestedLevels = 6;
    expect(compareRackLevels(plan).map((result) => result.levels)).toEqual([
      5, 6,
    ]);
    expect(
      compareRackLevels(plan, [20, 1, 20, 100]).map((result) => result.levels),
    ).toEqual([20, 1, 100]);
  });

  it("rejects a lowest shelf below minimum transfer height even when the highest shelf is reachable", () => {
    const plan = twentyTierPlan();
    plan.robot.minTransferHeight = 0.6;
    expect(checkStatus(plan, "LIFT_HEIGHT")).toBe("pass");
    expect(checkStatus(plan, "MIN_TRANSFER_HEIGHT")).toBe("fail");
    expect(checkStatus(plan, "TIER_1")).toBe("fail");
    expect(checkStatus(plan, "TIER_2")).toBe("pass");
    expect(comparison(plan).status).toBe("fail");
    expect(generateLayout(plan, []).maxLevelsByLift).toBe(0);
  });

  it("fails only the out-of-range high tiers and includes lifting clearance in the maximum reach check", () => {
    const plan = twentyTierPlan();
    plan.robot.maxLiftHeight = 19.55;
    expect(checkStatus(plan, "LIFT_HEIGHT")).toBe("fail");
    expect(checkStatus(plan, "TIER_19")).toBe("pass");
    expect(checkStatus(plan, "TIER_20")).toBe("fail");
    expect(generateLayout(plan, []).maxLevelsByLift).toBe(19);
  });

  it("keeps unknown transfer limits unverified instead of substituting example robot values", () => {
    const plan = twentyTierPlan();
    plan.robot.confirmed = false;
    plan.robot.minTransferHeight = null;
    plan.robot.maxLiftHeight = null;
    expect(validateSpacePlan(plan)).toEqual([]);
    expect(checkStatus(plan, "MIN_TRANSFER_HEIGHT")).toBe("needsReview");
    expect(checkStatus(plan, "LIFT_HEIGHT")).toBe("needsReview");
    expect(tiers(plan).every((tier) => tier.status === "needsReview")).toBe(
      true,
    );
    expect(comparison(plan).status).toBe("needsReview");
    const proposal = generateLayout(plan, []);
    expect(proposal.status).toBe("provisional");
    expect(proposal.maxLevelsByLift).toBeNull();
  });
});

describe("robot shelf pitch versus rack pitch", () => {
  it("allows different robot shelf pitch/count in liftRange mode when the full transfer range suffices", () => {
    const plan = twentyTierPlan();
    plan.robot.firstShelfHeight = 0.8;
    plan.robot.shelfPitch = 0.7;
    plan.robot.shelfCount = 4;
    expect(comparison(plan).status).toBe("pass");
    expect(tiers(plan)).toHaveLength(20);
    expect(tiers(plan).every((tier) => tier.status === "pass")).toBe(true);
    expect(generateLayout(plan, []).status).toBe("verified");
  });

  it("passes all 20 fixed levels when first height, pitch and count match", () => {
    const plan = twentyTierPlan();
    plan.robot.transferMode = "fixedLevels";
    expect(comparison(plan).status).toBe("pass");
    expect(checkStatus(plan, "ROBOT_SHELF_COUNT")).toBe("pass");
    expect(tiers(plan).every((tier) => tier.status === "pass")).toBe(true);
    expect(generateLayout(plan, []).maxLevelsByLift).toBe(20);
  });

  it("checks every fixed tier even when the top robot shelf exactly matches the top rack shelf", () => {
    const plan = twentyTierPlan();
    plan.robot.transferMode = "fixedLevels";
    // At tier 20: 0.69 + 19 × 0.99 = 19.5 m, matching the rack top.
    // Tier 1 differs by 0.19 m and intermediate tiers must still be rejected.
    plan.robot.firstShelfHeight = 0.69;
    plan.robot.shelfPitch = 0.99;
    expect(checkStatus(plan, "TIER_20")).toBe("pass");
    expect(checkStatus(plan, "TIER_1")).toBe("fail");
    expect(checkStatus(plan, "TIER_10")).toBe("fail");
    expect(tiers(plan).filter((tier) => tier.status === "fail")).toHaveLength(
      19,
    );
    expect(tiers(plan)[0].message).toContain("0.190");
    expect(comparison(plan).status).toBe("fail");
    expect(generateLayout(plan, []).maxLevelsByLift).toBe(0);
  });

  it("accumulates a pitch difference per tier instead of treating matching bottom shelves as sufficient", () => {
    const plan = twentyTierPlan();
    plan.robot.transferMode = "fixedLevels";
    plan.robot.shelfPitch = 0.99;
    plan.robot.alignmentTolerance = 0.025;
    expect(checkStatus(plan, "TIER_1")).toBe("pass");
    expect(checkStatus(plan, "TIER_3")).toBe("pass");
    expect(checkStatus(plan, "TIER_4")).toBe("fail");
    expect(checkStatus(plan, "TIER_20")).toBe("fail");
    expect(generateLayout(plan, []).maxLevelsByLift).toBe(3);
  });

  it("requires sufficient physical robot shelves in fixedLevels mode", () => {
    const plan = twentyTierPlan();
    plan.robot.transferMode = "fixedLevels";
    plan.robot.shelfCount = 19;
    expect(checkStatus(plan, "ROBOT_SHELF_COUNT")).toBe("fail");
    expect(checkStatus(plan, "TIER_19")).toBe("pass");
    expect(checkStatus(plan, "TIER_20")).toBe("fail");
    expect(generateLayout(plan, []).maxLevelsByLift).toBe(19);
  });

  it("retains unknown fixed shelf geometry as needsReview", () => {
    const plan = twentyTierPlan();
    plan.robot.confirmed = false;
    plan.robot.transferMode = "fixedLevels";
    plan.robot.firstShelfHeight = null;
    plan.robot.shelfPitch = null;
    plan.robot.shelfCount = null;
    expect(validateSpacePlan(plan)).toEqual([]);
    expect(checkStatus(plan, "FIXED_LEVEL_GEOMETRY")).toBe("needsReview");
    expect(checkStatus(plan, "ROBOT_SHELF_COUNT")).toBe("needsReview");
    expect(comparison(plan).status).toBe("needsReview");
    const proposal = generateLayout(plan, []);
    expect(proposal.maxLevelsByLift).toBeNull();
    expect(proposal.status).toBe("provisional");
  });
});

describe("elevation import validation and preservation", () => {
  it("preserves unknown nullable robot dimensions and the requested 20 tiers in a JSON round trip", () => {
    const plan = createSpacePlan();
    plan.layout.requestedLevels = 20;
    const project = createExampleProject();
    project.spacePlan = plan;
    const loaded = parseProject(JSON.parse(JSON.stringify(project)));
    expect(loaded.spacePlan).toEqual(plan);
    for (const key of [
      "minTransferHeight",
      "maxLiftHeight",
      "overallHeight",
      "firstShelfHeight",
      "shelfPitch",
      "shelfCount",
    ] as const)
      expect(loaded.spacePlan!.robot[key]).toBeNull();
    expect(loaded.spacePlan!.layout.requestedLevels).toBe(20);
  });

  it.each([
    ["minTransferHeight", -1],
    ["maxLiftHeight", "25"],
    ["firstShelfHeight", -1],
    ["shelfPitch", 0],
    ["shelfCount", 20.5],
    ["shelfCount", 101],
    ["alignmentTolerance", -0.01],
    ["transferMode", "unknown"],
  ])("rejects malformed robot %s=%s without coercion", (key, value) => {
    const plan = twentyTierPlan();
    const malformed = { ...plan, robot: { ...plan.robot, [key]: value } };
    expect(() => validateSpacePlan(malformed)).not.toThrow();
    expect(
      validateSpacePlan(malformed).some((issue) => issue.severity === "error"),
    ).toBe(true);
    const project = { ...createExampleProject(), spacePlan: malformed };
    expect(() => parseProject(project)).toThrow();
  });

  it("rejects inverted transfer ranges and invented confirmation of unknown minimum height", () => {
    const inverted = twentyTierPlan();
    inverted.robot.minTransferHeight = 26;
    expect(
      validateSpacePlan(inverted).some(
        (issue) => issue.code === "PLAN_TRANSFER_RANGE",
      ),
    ).toBe(true);
    const unknown = twentyTierPlan();
    unknown.robot.minTransferHeight = null;
    expect(
      validateSpacePlan(unknown).some(
        (issue) => issue.code === "PLAN_FALSE_CONFIRMATION",
      ),
    ).toBe(true);
  });

  it.each([0, 20.5, 101, "20", null])(
    "rejects unsupported requested level count %s",
    (requestedLevels) => {
      const plan = twentyTierPlan();
      expect(
        validateSpacePlan({
          ...plan,
          layout: { ...plan.layout, requestedLevels },
        }).some((issue) => issue.code === "PLAN_LEVELS"),
      ).toBe(true);
    },
  );

  it("fails explicit invalid comparison counts while keeping supported 1/20/100 comparisons available", () => {
    const plan = twentyTierPlan();
    for (const level of [0, 20.5, 101])
      expect(
        compareRackLevels(plan, [level])[0].checks.some(
          (check) => check.code === "LEVEL_COUNT" && check.status === "fail",
        ),
      ).toBe(true);
    for (const level of [1, 20, 100])
      expect(
        compareRackLevels(plan, [level])[0].checks.some(
          (check) => check.code === "LEVEL_COUNT",
        ),
      ).toBe(false);
  });
});

describe("layout capacity and geometric limits for high racks", () => {
  it("uses the requested 20 tiers for capacity and calculates independent height/lift tier ceilings", () => {
    const plan = twentyTierPlan();
    const proposal = generateLayout(plan, []);
    expect(proposal.placements.length).toBeGreaterThan(0);
    expect(proposal.capacityUnits).toBe(proposal.placements.length * 20);
    expect(proposal.maxLevelsByHeight).toBe(24);
    expect(proposal.maxLevelsByLift).toBe(25);
    expect(proposal.status).toBe("verified");
    plan.building.clearHeight = 20.8;
    plan.robot.overallHeight = 20.8;
    plan.robot.maxLiftHeight = 19.6;
    expect(generateLayout(plan, [])).toMatchObject({
      maxLevelsByHeight: 20,
      maxLevelsByLift: 20,
    });
    plan.building.clearHeight -= 0.001;
    plan.robot.overallHeight = plan.building.clearHeight;
    plan.robot.maxLiftHeight -= 0.001;
    expect(generateLayout(plan, [])).toMatchObject({
      maxLevelsByHeight: 19,
      maxLevelsByLift: 19,
      status: "provisional",
    });
  });

  it("produces repeatable nonoverlapping placements within boundary and cross-aisle clearances", () => {
    const plan = twentyTierPlan();
    const before = structuredClone(plan);
    const first = generateLayout(plan, []);
    expect(generateLayout(plan, [])).toEqual(first);
    expect(plan).toEqual(before);
    const inset = plan.layout.margin + plan.layout.crossAisle;
    for (const [index, placement] of first.placements.entries()) {
      const box = placementBounds(placement);
      expect(box.left).toBeGreaterThanOrEqual(inset - EPS);
      expect(box.top).toBeGreaterThanOrEqual(inset - EPS);
      expect(box.right).toBeLessThanOrEqual(plan.building.width - inset + EPS);
      expect(box.bottom).toBeLessThanOrEqual(plan.building.depth - inset + EPS);
      for (const other of first.placements.slice(index + 1))
        expect(intersects(box, placementBounds(other))).toBe(false);
    }
  });

  it("excludes the rotated obstacle AABB plus half the real robot aisle width", () => {
    const plan = twentyTierPlan();
    const obstacle: MapObject = {
      id: "column",
      name: "Column",
      kind: "column",
      x: 20,
      y: 12,
      width: 3,
      height: 2,
      rotation: 30,
    };
    const angle = Math.PI / 6;
    const halfX = (3 * Math.cos(angle) + 2 * Math.sin(angle)) / 2 + 1;
    const halfY = (3 * Math.sin(angle) + 2 * Math.cos(angle)) / 2 + 1;
    const excluded = {
      left: 20 - halfX,
      right: 20 + halfX,
      top: 12 - halfY,
      bottom: 12 + halfY,
    };
    const proposal = generateLayout(plan, [obstacle]);
    expect(proposal.placements.length).toBeGreaterThan(0);
    for (const placement of proposal.placements)
      expect(intersects(placementBounds(placement), excluded)).toBe(false);
    expect(proposal.capacityUnits).toBe(proposal.placements.length * 20);
  });

  it("returns no placements when the real robot footprint or aisle width is unknown", () => {
    for (const key of ["width", "length", "minAisleWidth"] as const) {
      const plan = twentyTierPlan();
      plan.robot.confirmed = false;
      plan.robot[key] = null;
      const proposal = generateLayout(plan, []);
      expect(proposal.placements).toEqual([]);
      expect(proposal.capacityUnits).toBe(0);
      expect(proposal.status).toBe("provisional");
    }
  });
});
