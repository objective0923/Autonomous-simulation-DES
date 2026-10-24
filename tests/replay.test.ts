import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createBenchmarkProjects } from "../src/examples";
import { parseSavedRun } from "../src/replay";

describe("saved run replay import", () => {
  const input = createBenchmarkProjects().singleRobot;
  const python =
    process.env.CROIS_PYTHON ??
    (process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python");
  const result = JSON.parse(
    execFileSync(
      python,
      [
        "-c",
        "import json,sys; from backend.engine import SimulationEngine; print(json.dumps(SimulationEngine(json.load(sys.stdin)).run(),allow_nan=False))",
      ],
      { input: JSON.stringify(input), encoding: "utf8" },
    ),
  );
  const run = () => ({
    input: structuredClone(input),
    result: structuredClone(result),
  });
  it("roundtrips recorded states without recalculating or changing the input", () => {
    const saved = run();
    const opened = parseSavedRun(JSON.parse(JSON.stringify(saved)));
    expect(opened).toEqual(saved);
    opened.result.history[0].robots[0].batteryWh = 0;
    expect(saved.result.history[0].robots[0].batteryWh).not.toBe(0);
  });
  it("rejects mismatched seeds, out of order history and unsafe renderer data", () => {
    const saved = run();
    saved.result.seed++;
    expect(() => parseSavedRun(saved)).toThrow(/시드/);
    const unordered = run();
    unordered.result.history.reverse();
    expect(() => parseSavedRun(unordered)).toThrow(/이력/);
    const invalid = run();
    (
      invalid.result.history[0].robots[0] as unknown as { movement: unknown }
    ).movement = { from: "missing", to: "missing" };
    expect(() => parseSavedRun(invalid)).toThrow(/이력/);
    const kpi = run();
    (kpi.result.kpis as unknown as { meanLeadTime: unknown }).meanLeadTime =
      "invalid";
    expect(() => parseSavedRun(kpi)).toThrow(/KPI/);
  });
});
