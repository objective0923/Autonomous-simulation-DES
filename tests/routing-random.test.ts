import { describe, expect, it } from "vitest";
import { createRandom, sampleDistribution } from "../src/random";
import { findRoute, physicalZone, segmentTravelTime } from "../src/routing";
import type { Project, RobotType } from "../src/types";

const type: RobotType = {
  id: "low",
  name: "test",
  width: 1,
  length: 1.2,
  maxPayloadKg: 100,
  maxUnits: 2,
  cargoTypes: ["A"],
  emptySpeed: 2,
  loadedSpeed: 1,
  acceleration: 1,
  turnTime: 2,
  loadTime: 3,
  unloadTime: 3,
  batteryCapacityWh: 100,
  idlePowerW: 1,
  emptyPowerW: 10,
  loadedPowerW: 20,
  reserveWh: 5,
  chargeBelowWh: 10,
  chargeToWh: 90,
};
function graph(): Project {
  return {
    schemaVersion: "1.0",
    id: "route",
    name: "test",
    description: "",
    modelVersion: "1",
    assumptions: [],
    nodes: [
      { id: "a", name: "a", x: 0, y: 0, kind: "pickup" },
      { id: "b", name: "b", x: 10, y: 0, kind: "intersection" },
      { id: "c", name: "c", x: 10, y: 10, kind: "dropoff" },
    ],
    edges: [
      {
        id: "ab",
        from: "a",
        to: "b",
        length: 10,
        width: 2,
        speedLimit: 2,
        bidirectional: true,
      },
      {
        id: "bc",
        from: "b",
        to: "c",
        length: 10,
        width: 2,
        speedLimit: 2,
        bidirectional: false,
      },
    ],
    objects: [],
    buffers: [],
    robotTypes: [type],
    robots: [],
    chargers: [],
    processes: [],
    transportRules: [],
    equipment: [],
    disruptions: [],
    settings: { duration: 100, seed: 1, dispatchPolicy: "fifo", warmup: 0 },
  };
}

describe("named deterministic random streams", () => {
  it("reproduces sequences and isolates each stream from unrelated sampling", () => {
    const a = createRandom(42, "process:A");
    const b = createRandom(42, "process:A");
    const unrelated = createRandom(42, "process:B");
    for (let i = 0; i < 100; i++) {
      unrelated();
      expect(a()).toBe(b());
    }
    expect(createRandom(43, "process:A")()).not.toBe(
      createRandom(42, "process:A")(),
    );
  });
  it("samples every supported nonnegative distribution deterministically", () => {
    const distributions = [
      { kind: "fixed", value: 3 },
      { kind: "uniform", min: 2, max: 4 },
      { kind: "triangular", min: 1, mode: 2, max: 5 },
      { kind: "normal", mean: 3, sd: 2, min: 0, max: 6 },
      { kind: "lognormal", mu: 1, sigma: 0.2 },
      { kind: "exponential", mean: 3 },
      { kind: "empirical", values: [2, 4, 8] },
    ] as const;
    distributions.forEach((distribution) => {
      const d = JSON.parse(JSON.stringify(distribution));
      const rng = createRandom(7, d.kind);
      for (let i = 0; i < 100; i++)
        expect(sampleDistribution(d, rng)).toBeGreaterThanOrEqual(0);
    });
  });
  it("rejects invalid ranges, invalid RNG and unsafe outputs", () => {
    expect(() =>
      sampleDistribution({ kind: "uniform", min: 3, max: 1 }, () => 0.5),
    ).toThrow();
    expect(() =>
      sampleDistribution({ kind: "empirical", values: [] }, () => 0.5),
    ).toThrow();
    expect(() =>
      sampleDistribution({ kind: "exponential", mean: 1 }, () => 1),
    ).toThrow();
    expect(() =>
      sampleDistribution({ kind: "lognormal", mu: 1000, sigma: 0 }, () => 0.5),
    ).toThrow();
  });
});

describe("physical routing", () => {
  it("respects direction, width, exclusions and unknown nodes", () => {
    const project = graph();
    expect(findRoute(project, "a", "c", type)?.nodes).toEqual(["a", "b", "c"]);
    expect(findRoute(project, "c", "a", type)).toBeNull();
    expect(findRoute(project, "missing", "missing", type)).toBeNull();
    project.edges[1].width = 0.9;
    expect(findRoute(project, "a", "c", type)).toBeNull();
    project.edges[1].width = 2;
    project.edges[1].allowedRobotTypes = ["other"];
    expect(findRoute(project, "a", "c", type)).toBeNull();
  });
  it("uses acceleration, load speed, intermediate turn time and one physical lock", () => {
    const project = graph();
    const empty = findRoute(project, "a", "c", type)!;
    const loaded = findRoute(project, "a", "c", type, true)!;
    expect(empty.time).toBe(16); // two 7-second edges plus 2-second turn
    expect(loaded.time).toBe(24);
    expect(segmentTravelTime(1, 2, 1)).toBe(2);
    expect(findRoute(project, "b", "a", type)?.legs[0].zoneId).toBe(
      empty.legs[0].zoneId,
    );
    expect(physicalZone({ ...project.edges[0], from: "b", to: "a" })).toBe(
      empty.legs[0].zoneId,
    );
  });
  it("chooses the quickest feasible path instead of geometric distance alone", () => {
    const project = graph();
    project.edges.push({
      id: "ac",
      from: "a",
      to: "c",
      length: 12,
      width: 2,
      speedLimit: 0.1,
      bidirectional: true,
    });
    expect(
      findRoute(project, "a", "c", type)?.legs.map((x) => x.edgeId),
    ).toEqual(["ab", "bc"]);
    project.edges[0].disabled = true;
    expect(
      findRoute(project, "a", "c", type)?.legs.map((x) => x.edgeId),
    ).toEqual(["ac"]);
  });
});
