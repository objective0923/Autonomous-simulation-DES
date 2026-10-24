import { describe, expect, it } from "vitest";
import { createBenchmarkProjects, createExampleProject } from "../src/examples";
import { cloneProject, parseProject, validateProject } from "../src/model";
import type { Project } from "../src/types";

describe("project schema and operational validation", () => {
  it("validates every delivered project without errors or warnings", () => {
    for (const project of [
      createExampleProject(),
      ...Object.values(createBenchmarkProjects()),
    ])
      expect(validateProject(project), project.name).toEqual([]);
  });
  it("handles malformed JSON structures without throwing", () => {
    for (const value of [
      null,
      undefined,
      "not a project",
      3,
      [],
      {},
      { nodes: [null, 1, "x"], settings: [] },
    ]) {
      expect(() => validateProject(value)).not.toThrow();
      expect(validateProject(value).some((i) => i.severity === "error")).toBe(
        true,
      );
      expect(() => parseProject(value)).toThrow();
    }
  });
  it("roundtrips every field and clones rather than aliasing imported objects", () => {
    const input = createExampleProject();
    const result = parseProject(JSON.parse(JSON.stringify(input)));
    expect(result).toEqual(input);
    result.nodes[0].x = 100;
    expect(input.nodes[0].x).toBe(4);
    expect(cloneProject(input)).toEqual(input);
  });
  it("rejects unsupported schema and unit assumptions", () => {
    const p = {
      ...createExampleProject(),
      schemaVersion: "2.0",
      units: { distance: "mm" },
    };
    expect(validateProject(p).map((i) => i.code)).toEqual(
      expect.arrayContaining(["SCHEMA_VERSION", "UNITS"]),
    );
  });
  it("rejects missing references, globally duplicate IDs, invalid counts and over-capacity buffers", () => {
    const p = createExampleProject();
    p.edges[0].to = "missing";
    p.buffers[0].id = p.nodes[0].id;
    p.buffers[1].initialInventory = { B: 100.5 };
    p.robots[0].initialBatteryWh = -1;
    expect(validateProject(p).map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "MISSING_REFERENCE",
        "DUPLICATE_ID",
        "QUANTITY_RANGE",
        "BUFFER_OVERFLOW",
        "NUMBER_RANGE",
      ]),
    );
  });
  it("rejects invalid process distributions and charging thresholds", () => {
    const p = createExampleProject();
    p.processes[0].processingTime = {
      kind: "triangular",
      min: 10,
      mode: 5,
      max: 20,
    };
    p.robotTypes[0].chargeToWh = 300;
    expect(validateProject(p).map((i) => i.code)).toEqual(
      expect.arrayContaining(["DISTRIBUTION_ORDER", "BATTERY_THRESHOLDS"]),
    );
  });
  it("detects disconnected, width-limited and direction-limited transport routes", () => {
    const p = createBenchmarkProjects().singleRobot;
    p.edges[0].width = 0.5;
    expect(validateProject(p).map((i) => i.code)).toContain("NO_ROUTE");
    p.edges[0].width = 2;
    p.edges[0].bidirectional = false;
    [p.edges[0].from, p.edges[0].to] = [p.edges[0].to, p.edges[0].from];
    expect(validateProject(p).map((i) => i.code)).toContain("NO_ROUTE");
  });
  it("rejects inconsistent physical corridor zones even on parallel same-direction edges", () => {
    const p = createBenchmarkProjects().singleRobot;
    p.edges.push({
      ...p.edges[0],
      id: "duplicate-route",
      zoneId: "independent",
    });
    expect(validateProject(p).map((i) => i.code)).toContain("OPPOSITE_ZONE");
  });
  it("rejects prototype record keys before simulation touches dictionary state", () => {
    for (const key of [
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "valueOf",
    ]) {
      const p = createExampleProject();
      p.buffers[0].initialInventory = JSON.parse(`{"${key}":1}`);
      expect(validateProject(p).map((i) => i.code)).toContain("UNSAFE_KEY");
      p.nodes[0].id = key;
      expect(validateProject(p).map((i) => i.code)).toContain("UNSAFE_KEY");
    }
  });
  it("distinguishes geometric review warnings from invalid runnable structure", () => {
    const p = createExampleProject();
    p.objects[1].x = p.objects[0].x;
    p.objects[1].y = p.objects[0].y;
    expect(
      validateProject(p).some(
        (i) => i.code === "OBJECT_OVERLAP" && i.severity === "warning",
      ),
    ).toBe(true);
    expect(() => parseProject(p)).not.toThrow();
  });
  it("requires a safe integer seed and finite settings", () => {
    const p: Project = createExampleProject();
    p.settings.seed = Number.MAX_SAFE_INTEGER + 1;
    p.settings.duration = Infinity;
    expect(validateProject(p).map((i) => i.code)).toEqual(
      expect.arrayContaining(["SEED_RANGE", "NUMBER_RANGE"]),
    );
  });
});
