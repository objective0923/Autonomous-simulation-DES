import type { Project, SimulationResult } from "./types";
import { parseSavedRun } from "./replay";

/** Calculation runs on the server. This browser client never runs a DES engine. */
export const ENGINE_VERSION = "SimPy 4.1.1";

function errorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(errorDetail).join(" · ");
  if (value && typeof value === "object") {
    const data = value as Record<string, unknown>;
    if (typeof data.msg === "string")
      return `${Array.isArray(data.loc) ? data.loc.join(".") + ": " : ""}${data.msg}`;
    if ("detail" in data) return errorDetail(data.detail);
    if (typeof data.message === "string") return data.message;
  }
  return "";
}

export async function runSimulation(
  project: Project,
  signal?: AbortSignal,
): Promise<SimulationResult> {
  let response: Response;
  try {
    response = await fetch("/api/simulate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ project }),
      signal,
    });
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw new DOMException("계산 요청을 취소했습니다.", "AbortError");
    throw new Error(
      "SimPy 서버에 연결할 수 없습니다. 웹 서버와 Python API 서버가 실행 중인지 확인하세요.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `SimPy 서버 응답을 읽을 수 없습니다 (HTTP ${response.status}). API 서버 상태를 확인하세요.`,
    );
  }
  if (!response.ok) {
    const detail = errorDetail(body);
    if (response.status === 422)
      throw new Error(
        `시뮬레이션 입력을 확인하세요${detail ? ": " + detail : "."}`,
      );
    if (response.status === 503)
      throw new Error(
        `SimPy 계산 서버가 사용 중이거나 준비되지 않았습니다. 잠시 후 다시 실행하세요${detail ? ": " + detail : "."}`,
      );
    throw new Error(
      `SimPy 계산 실패 (HTTP ${response.status})${detail ? ": " + detail : "."}`,
    );
  }
  try {
    return parseSavedRun({ input: project, result: body }).result;
  } catch (error) {
    throw new Error(
      `SimPy 결과 형식이 올바르지 않습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
