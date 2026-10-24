import type { EventRecord, Project, SimulationResult, Snapshot } from "./types";

/** A cursor over server-generated records. No event scheduling, RNG or KPI calculation. */
export class SimulationPlayback {
  private readonly result: SimulationResult;
  private cursor = 0;
  private time = 0;

  constructor(project: Project, result: SimulationResult) {
    if (project.id !== result.projectId)
      throw new Error("프로젝트와 실행 기록의 ID가 다릅니다.");
    if (!result.history.length) throw new Error("재생할 상태 기록이 없습니다.");
    this.result = structuredClone(result);
    this.time = Math.min(result.horizon, Math.max(0, result.history[0].time));
  }

  /** One stored state transition, including distinct records at the same time. */
  step(): Snapshot {
    if (this.cursor < this.result.history.length - 1) {
      this.cursor++;
      this.time = this.result.history[this.cursor].time;
    } else this.time = this.result.horizon;
    return this.getSnapshot();
  }

  runUntil(target: number, _maxEvents?: number): Snapshot {
    if (!Number.isFinite(target))
      throw new Error("재생 시각은 유한한 수여야 합니다.");
    this.time = Math.max(this.time, Math.min(this.result.horizon, target));
    const history = this.result.history;
    let low = this.cursor,
      high = history.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (history[middle].time <= this.time) low = middle + 1;
      else high = middle;
    }
    this.cursor = Math.max(this.cursor, low - 1);
    return this.getSnapshot();
  }

  run(_until?: number): SimulationResult {
    this.cursor = this.result.history.length - 1;
    this.time = this.result.horizon;
    return this.getResult();
  }

  getSnapshot(): Snapshot {
    const snapshot = structuredClone(this.result.history[this.cursor]);
    // The clock is a playback cursor for movement interpolation; all model state is recorded.
    snapshot.time = this.time;
    snapshot.finished = this.time >= this.result.horizon;
    return snapshot;
  }

  getResult(): SimulationResult {
    return structuredClone(this.result);
  }

  getEvents(limit = Infinity): EventRecord[] {
    const snapshot = this.result.history[this.cursor];
    const sequence = snapshot.lastEventSequence;
    let low = 0,
      high = this.result.events.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const event = this.result.events[middle];
      if (
        sequence === undefined
          ? event.time <= this.time
          : event.sequence <= sequence
      )
        low = middle + 1;
      else high = middle;
    }
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : low;
    return structuredClone(
      this.result.events.slice(Math.max(0, low - count), low),
    );
  }
}
