import { describe, expect, it } from "vitest";
import { buildElevationRows } from "../src/elevation";
import { createSpacePlan } from "../src/planning";

describe("common floor datum and arbitrary-tier elevation", () => {
  it("shows each of 20 tiers with correct first height and pitch", () => {
    const p = createSpacePlan();
    p.layout.requestedLevels = 20;
    p.rack.firstShelfHeight = 0.2;
    p.rack.shelfPitch = 0.12;
    p.rack.loadHeight = 0.08;
    p.rack.liftClearance = 0.02;
    p.rack.beamThickness = 0.01;
    const rows = buildElevationRows(p);
    expect(rows).toHaveLength(20);
    expect(rows[19].rackHeight).toBeCloseTo(2.48);
    expect(rows[19].loadTop).toBeCloseTo(2.56);
    expect(rows.every((r) => r.status === "needsReview")).toBe(true);
  });
  it("does not require equal shelf pitch for a continuously lifting CTU", () => {
    const p = createSpacePlan();
    p.robot.minTransferHeight = 0.1;
    p.robot.maxLiftHeight = 20;
    p.robot.firstShelfHeight = 0.3;
    p.robot.shelfPitch = 0.2;
    p.robot.shelfCount = 6;
    p.rack.firstShelfHeight = 0.4;
    p.rack.shelfPitch = 0.3;
    p.rack.loadHeight = 0.1;
    p.rack.liftClearance = 0.05;
    p.rack.beamThickness = 0.05;
    expect(
      buildElevationRows(p, 20).some((r) => r.reason.includes("공차")),
    ).toBe(false);
    p.robot.transferMode = "fixedLevels";
    expect(buildElevationRows(p, 5).every((r) => r.status === "fail")).toBe(
      true,
    );
  });
  it("reports low rack handoff even when the highest tier is reachable", () => {
    const p = createSpacePlan();
    p.robot.minTransferHeight = 0.6;
    p.robot.maxLiftHeight = 20;
    p.rack.firstShelfHeight = 0.4;
    expect(buildElevationRows(p, 5)[0]).toMatchObject({
      status: "fail",
      reason: "최저 인계 가능 높이보다 낮음",
    });
    expect(buildElevationRows(p, 5)[4].reason).not.toContain("최저");
  });
});
