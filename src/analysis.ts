import type { Project, SimulationResult } from "./types";
import { runSimulation } from "./api";

export interface SampleSummary {
  n: number;
  mean: number;
  standardDeviation: number | null;
  confidence95: [number, number] | null;
  method: string;
}

/** Two-sided Student t, 0.975 quantiles. Conservative df bracket for n > 31. */
const T975 = [
  0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
  2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function summarizeSamples(values: number[]): SampleSummary {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    throw new Error("유한한 반복 실행 결과가 필요합니다.");
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2)
    return {
      n,
      mean,
      standardDeviation: null,
      confidence95: null,
      method: "반복 1회: 표준편차 및 평균 신뢰구간 산출 불가",
    };
  const sd = Math.sqrt(
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1),
  );
  const df = n - 1;
  const t = df <= 30 ? T975[df] : df < 60 ? 2.042 : df < 120 ? 2.001 : 1.98;
  const margin = (t * sd) / Math.sqrt(n);
  return {
    n,
    mean,
    standardDeviation: sd,
    confidence95: [mean - margin, mean + margin],
    method:
      "독립 시드 반복, 표본 표준편차, 양측 Student t 평균 95% CI (자유도 구간의 보수적 임계값); 개별 작업 지연 P95와 다름",
  };
}

export async function runReplications(project: Project, seeds: number[]) {
  if (
    seeds.length < 1 ||
    seeds.length > 100 ||
    seeds.some((s) => !Number.isSafeInteger(s))
  )
    throw new Error("반복 시드는 1~100개의 정수로 지정하세요.");
  if (new Set(seeds).size !== seeds.length)
    throw new Error("독립 반복에는 서로 다른 시드를 사용하세요.");
  const runs: SimulationResult[] = [];
  for (const seed of seeds) {
    const input = structuredClone(project);
    input.settings.seed = seed;
    runs.push(await runSimulation(input));
  }
  return {
    projectId: project.id,
    seeds: [...seeds],
    initialState:
      "매 반복마다 원본 프로젝트의 초기 재고·위치·배터리에서 새 엔진 생성",
    productionPerHour: summarizeSamples(
      runs.map((r) => r.kpis.productionPerHour),
    ),
    transportPerHour: summarizeSamples(
      runs.map((r) => r.kpis.transportPerHour),
    ),
    meanLeadTime: summarizeSamples(runs.map((r) => r.kpis.meanLeadTime)),
    runs,
  };
}

/** RFC 4180 quoting, with formula neutralisation for spreadsheet consumers. */
export function csvCell(value: unknown): string {
  let cell = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = "'" + cell;
  return '"' + cell.replaceAll('"', '""') + '"';
}

export function eventsToCsv(result: SimulationResult): string {
  const columns = [
    "sequence",
    "time_s",
    "kind",
    "robotId",
    "jobId",
    "resourceId",
    "message",
    "cause",
  ];
  const records = result.events.map((e) => [
    e.sequence,
    e.time,
    e.kind,
    e.robotId,
    e.jobId,
    e.resourceId,
    e.message,
    e.cause,
  ]);
  return (
    "\uFEFF" +
    [columns, ...records].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}
