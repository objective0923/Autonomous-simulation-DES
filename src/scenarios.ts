import type { Project, SimulationResult } from "./types";
import { parseProject } from "./model";
import { parseSavedRun } from "./replay";

export interface ScenarioSummary {
  id: string;
  customerName: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  hasResult: boolean;
}
export interface ScenarioDetail extends ScenarioSummary {
  project: Project;
  result: SimulationResult | null;
}
export class ScenarioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request(path: string, options?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/scenarios${path}`, options);
  } catch {
    throw new ScenarioError(
      "저장함에 연결할 수 없습니다. 웹과 Python 서버가 실행 중인지 확인한 뒤 다시 시도하세요.",
      0,
    );
  }
  if (response.status === 204) return null;
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? (data as { detail: unknown }).detail
        : null;
    throw new ScenarioError(
      typeof detail === "string"
        ? detail
        : `시나리오 요청에 실패했습니다 (HTTP ${response.status}).`,
      response.status,
    );
  }
  return data;
}
function summary(value: unknown): ScenarioSummary {
  if (!value || typeof value !== "object")
    throw new Error("시나리오 목록 형식이 올바르지 않습니다.");
  const v = value as Record<string, unknown>;
  if (
    ["id", "customerName", "name", "createdAt", "updatedAt"].some(
      (k) => typeof v[k] !== "string",
    ) ||
    typeof v.hasResult !== "boolean" ||
    !(v.lastRunAt === null || typeof v.lastRunAt === "string")
  )
    throw new Error("시나리오 정보가 올바르지 않습니다.");
  return v as unknown as ScenarioSummary;
}
function detail(value: unknown): ScenarioDetail {
  const metadata = summary(value);
  const v = value as Record<string, unknown>;
  const project = parseProject(v.project);
  const result =
    v.result === null
      ? null
      : parseSavedRun({ input: project, result: v.result }).result;
  return { ...metadata, project, result };
}
export async function listScenarios(
  signal?: AbortSignal,
): Promise<ScenarioSummary[]> {
  const data = await request("", { signal });
  if (
    !data ||
    typeof data !== "object" ||
    !("scenarios" in data) ||
    !Array.isArray(data.scenarios)
  )
    throw new Error("시나리오 목록을 읽지 못했습니다.");
  return data.scenarios.map(summary);
}
export async function getScenario(id: string): Promise<ScenarioDetail> {
  return detail(await request(`/${encodeURIComponent(id)}`));
}
export async function createScenario(
  project: Project,
): Promise<ScenarioDetail> {
  return detail(
    await request("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: project.customerName,
        name: project.name,
        project,
      }),
    }),
  );
}
export async function updateScenario(
  project: Project,
): Promise<ScenarioDetail> {
  return detail(
    await request(`/${encodeURIComponent(project.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: project.customerName,
        name: project.name,
        project,
      }),
    }),
  );
}
export async function deleteScenario(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export const scenarioKey = (value: string) =>
  value.trim().toLocaleLowerCase("ko-KR");
