import { describe, expect, it } from "vitest";
import { SimulationPlayback } from "../src/playback";
import { createExampleProject } from "../src/examples";
import type { SimulationResult, Snapshot } from "../src/types";

function fixture() {
  const project = createExampleProject();
  const state = (
    time: number,
    sequence: number,
    count: number,
    finished = false,
  ): Snapshot => ({
    time,
    lastEventSequence: sequence,
    eventCount: count,
    robots: [],
    buffers: [],
    processes: [],
    chargers: [],
    jobs: [],
    zoneOwners: {},
    diagnostics: [],
    finished,
  });
  const history = [
    state(0, 0, 0),
    state(5, 2, 1),
    state(5, 3, 2),
    state(20, 4, 3, true),
  ];
  const result: SimulationResult = {
    runId: "server-recorded-run",
    projectId: project.id,
    scenarioId: project.id,
    engineVersion: "SimPy 4.1.1",
    modelVersion: project.modelVersion,
    seed: project.settings.seed,
    horizon: 20,
    measurementStart: 0,
    assumptions: [],
    kpis: {
      productionCompleted: 99,
      transportCompleted: 40,
      productionPerHour: 17820,
      transportPerHour: 7200,
      meanLeadTime: 3,
      p95LeadTime: 5,
      meanDispatchWait: 1,
      overdueJobs: 0,
      unfinishedJobs: 2,
      emptyDistanceRatio: 0.3,
      measurementSeconds: 20,
      robotStateSeconds: {},
      chargerUtilization: {},
      bufferOccupancy: {},
      processStateSeconds: {},
      maxChargeQueue: 0,
    },
    events: [1, 2, 3, 4].map((sequence) => ({
      sequence,
      time: sequence === 4 ? 20 : 5,
      kind: "recorded",
      message: `Server event ${sequence}`,
    })),
    history,
    finalState: history[3],
    diagnostics: [],
  };
  return { project, result };
}

describe("display-only server record playback", () => {
  it("steps through distinct records at the same time and limits logs by recorded sequence", () => {
    const { project, result } = fixture();
    const playback = new SimulationPlayback(project, result);
    expect(playback.getEvents()).toEqual([]);
    expect(playback.step().lastEventSequence).toBe(2);
    expect(playback.getEvents().map((e) => e.sequence)).toEqual([1, 2]);
    expect(playback.step().time).toBe(5);
    expect(playback.getEvents().map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(playback.getEvents(1).map((e) => e.sequence)).toEqual([3]);
  });

  it("advances only the presentation clock between records and never calculates KPI values", () => {
    const { project, result } = fixture();
    const playback = new SimulationPlayback(project, result);
    expect(playback.runUntil(10)).toMatchObject({
      time: 10,
      eventCount: 2,
      lastEventSequence: 3,
      finished: false,
    });
    expect(playback.runUntil(7).time).toBe(10);
    expect(playback.getResult().kpis).toEqual(result.kpis);
    expect(playback.run().finalState).toEqual(result.finalState);
    expect(playback.getSnapshot()).toMatchObject({ time: 20, finished: true });
    expect(playback.getResult().kpis.productionCompleted).toBe(99);
  });

  it("keeps original server records immutable and supports older logs without sequence markers", () => {
    const { project, result } = fixture();
    result.history.forEach((s) => delete s.lastEventSequence);
    const playback = new SimulationPlayback(project, result);
    const view = playback.runUntil(5);
    view.zoneOwners.fake = "changed";
    expect(playback.getSnapshot().zoneOwners).toEqual({});
    expect(playback.getEvents()).toHaveLength(3);
    const exported = playback.getResult();
    exported.kpis.productionCompleted = 0;
    expect(playback.getResult().kpis.productionCompleted).toBe(99);
    expect(result.history[2].time).toBe(5);
  });
});
