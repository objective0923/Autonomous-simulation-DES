import { parseProject } from "./model";
import type { Project, SimulationResult } from "./types";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const statuses = new Set([
  "idle",
  "emptyTravel",
  "loading",
  "loadedTravel",
  "unloading",
  "trafficWait",
  "equipmentWait",
  "chargeWait",
  "docking",
  "charging",
  "undocking",
  "failed",
]);
const processStatuses = new Set([
  "idle",
  "processing",
  "materialWait",
  "outputWait",
  "equipmentWait",
  "failed",
]);
const jobStatuses = new Set([
  "waiting",
  "assigned",
  "loading",
  "transporting",
  "unloading",
  "completed",
  "failed",
  "cancelled",
]);

/** Validate saved replay data before UI access; this never creates an engine. */
export function parseSavedRun(value: unknown): {
  input: Project;
  result: SimulationResult;
} {
  const fail = (message: string): never => {
    throw new Error(`실행 기록 형식 오류: ${message}`);
  };
  if (!object(value) || !object(value.result))
    return fail("{input, result} 형식이 필요합니다.");
  const input = parseProject(value.input);
  const result = value.result;
  const list = (v: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(v) || v.some((x) => !object(x)))
      return fail("상태·이벤트는 객체 배열이어야 합니다.");
    return v as Record<string, unknown>[];
  };
  const nonnegative = (v: unknown) => finite(v) && v >= 0;
  const numMap = (v: unknown) =>
    object(v) && Object.values(v).every(nonnegative);
  const namedMaps = (v: unknown) => object(v) && Object.values(v).every(numMap);
  const strings = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const ids = (items: { id: string }[]) => new Set(items.map((x) => x.id));
  const nodeIds = ids(input.nodes),
    robotIds = ids(input.robots),
    bufferIds = ids(input.buffers),
    processIds = ids(input.processes),
    chargerIds = ids(input.chargers);
  for (const key of [
    "runId",
    "projectId",
    "scenarioId",
    "engineVersion",
    "modelVersion",
  ])
    if (typeof result[key] !== "string") fail(`${key} 문자열이 필요합니다.`);
  if (
    result.projectId !== input.id ||
    result.modelVersion !== input.modelVersion ||
    result.seed !== input.settings.seed
  )
    fail("입력과 실행의 프로젝트·모델 버전·시드가 일치하지 않습니다.");
  if (
    ![result.horizon, result.measurementStart].every(nonnegative) ||
    (result.measurementStart as number) > (result.horizon as number) ||
    result.measurementStart !== input.settings.warmup ||
    (result.horizon as number) > input.settings.duration
  )
    fail("측정 구간이 올바르지 않습니다.");
  if (!strings(result.assumptions)) fail("모델 가정 목록이 필요합니다.");
  const diagnostics = (v: unknown) =>
    list(v).every(
      (d) =>
        ["error", "warning"].includes(String(d.severity)) &&
        typeof d.code === "string" &&
        typeof d.message === "string" &&
        (d.entityId === undefined || typeof d.entityId === "string"),
    );
  if (!diagnostics(result.diagnostics)) fail("진단 항목이 올바르지 않습니다.");
  const kp = result.kpis;
  if (!object(kp)) return fail("KPI가 필요합니다.");
  for (const key of [
    "productionCompleted",
    "transportCompleted",
    "productionPerHour",
    "transportPerHour",
    "meanLeadTime",
    "p95LeadTime",
    "meanDispatchWait",
    "overdueJobs",
    "unfinishedJobs",
    "emptyDistanceRatio",
    "measurementSeconds",
    "maxChargeQueue",
  ])
    if (!nonnegative(kp[key])) fail(`유효한 KPI ${key}가 필요합니다.`);
  if (
    !namedMaps(kp.robotStateSeconds) ||
    !namedMaps(kp.processStateSeconds) ||
    !numMap(kp.chargerUtilization) ||
    !numMap(kp.bufferOccupancy)
  )
    fail("자원별 KPI가 올바르지 않습니다.");
  let previousTime = -1,
    previousSequence = 0;
  for (const event of list(result.events)) {
    if (
      !nonnegative(event.time) ||
      (event.time as number) < previousTime ||
      (event.time as number) > (result.horizon as number) ||
      !Number.isSafeInteger(event.sequence) ||
      (event.sequence as number) <= previousSequence ||
      typeof event.kind !== "string" ||
      typeof event.message !== "string"
    )
      fail("이벤트 순서·시각·내용이 올바르지 않습니다.");
    for (const key of ["robotId", "jobId", "resourceId", "cause"])
      if (event[key] !== undefined && typeof event[key] !== "string")
        fail("이벤트 참조가 올바르지 않습니다.");
    previousTime = event.time as number;
    previousSequence = event.sequence as number;
  }
  const snapshot = (s: unknown): boolean => {
    if (
      !object(s) ||
      !nonnegative(s.time) ||
      (s.time as number) > (result.horizon as number) ||
      !Number.isSafeInteger(s.eventCount) ||
      (s.eventCount as number) < 0 ||
      (s.lastEventSequence !== undefined &&
        (!Number.isSafeInteger(s.lastEventSequence) ||
          (s.lastEventSequence as number) < 0)) ||
      typeof s.finished !== "boolean" ||
      !object(s.zoneOwners) ||
      Object.values(s.zoneOwners).some((id) => !robotIds.has(String(id))) ||
      !diagnostics(s.diagnostics)
    )
      return false;
    const robots = list(s.robots),
      buffers = list(s.buffers),
      processes = list(s.processes),
      chargers = list(s.chargers),
      jobs = list(s.jobs);
    if (
      robots.length !== robotIds.size ||
      new Set(robots.map((r) => r.id)).size !== robotIds.size ||
      buffers.length !== bufferIds.size ||
      new Set(buffers.map((b) => b.id)).size !== bufferIds.size ||
      processes.length !== processIds.size ||
      new Set(processes.map((p) => p.id)).size !== processIds.size ||
      chargers.length !== chargerIds.size ||
      new Set(chargers.map((c) => c.id)).size !== chargerIds.size
    )
      return false;
    for (const r of robots) {
      if (
        !robotIds.has(String(r.id)) ||
        !nodeIds.has(String(r.nodeId)) ||
        !statuses.has(String(r.status)) ||
        ![r.batteryWh, r.distanceEmpty, r.distanceLoaded, r.stateSince].every(
          nonnegative,
        ) ||
        !numMap(r.stateTimes)
      )
        return false;
      if (
        r.movement !== undefined &&
        (!object(r.movement) ||
          !nodeIds.has(String(r.movement.from)) ||
          !nodeIds.has(String(r.movement.to)) ||
          ![r.movement.startedAt, r.movement.endsAt].every(nonnegative) ||
          (r.movement.endsAt as number) < (r.movement.startedAt as number))
      )
        return false;
      if (
        r.carrying !== undefined &&
        (!object(r.carrying) ||
          typeof r.carrying.product !== "string" ||
          !nonnegative(r.carrying.quantity))
      )
        return false;
    }
    for (const b of buffers)
      if (
        !bufferIds.has(String(b.id)) ||
        !numMap(b.inventory) ||
        !numMap(b.reservedOut) ||
        ![b.reservedIn, b.maxOccupancy].every(nonnegative)
      )
        return false;
    for (const p of processes)
      if (
        !processIds.has(String(p.id)) ||
        !processStatuses.has(String(p.status)) ||
        ![p.produced, p.stateSince].every(nonnegative) ||
        !numMap(p.stateTimes)
      )
        return false;
    for (const c of chargers)
      if (
        !chargerIds.has(String(c.id)) ||
        ![c.occupants, c.queue, c.reserved].every(
          (x) => strings(x) && (x as string[]).every((id) => robotIds.has(id)),
        ) ||
        typeof c.failed !== "boolean" ||
        ![c.busySeconds, c.maxQueue].every(nonnegative)
      )
        return false;
    for (const j of jobs)
      if (
        typeof j.id !== "string" ||
        !bufferIds.has(String(j.sourceBufferId)) ||
        !bufferIds.has(String(j.destinationBufferId)) ||
        typeof j.product !== "string" ||
        !jobStatuses.has(String(j.status)) ||
        ![j.quantity, j.unitWeightKg, j.priority, j.requestedAt].every(
          nonnegative,
        ) ||
        (j.robotId !== undefined && !robotIds.has(String(j.robotId)))
      )
        return false;
    return true;
  };
  if (
    !snapshot(result.finalState) ||
    (result.finalState as Record<string, unknown>).time !== result.horizon
  )
    fail("최종 상태가 실행 구간과 일치하지 않습니다.");
  previousTime = -1;
  const history = list(result.history);
  if (!history.length) fail("재생할 상태 이력이 없습니다.");
  for (const item of history) {
    if (!snapshot(item) || (item.time as number) < previousTime)
      fail("상태 이력의 시각·자원·참조가 올바르지 않습니다.");
    previousTime = item.time as number;
  }
  return structuredClone({ input, result }) as unknown as {
    input: Project;
    result: SimulationResult;
  };
}
