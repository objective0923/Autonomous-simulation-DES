/**
 * CTU Rack Vertical Simulator — 계산 코어
 *
 * 공간 높이, 제품 높이, 로봇 전고·작업면 높이로부터
 *   (1) 검토 랙(단수·높이)의 설치 가능 여부
 *   (2) 해당 공간에서 가능한 최대 단수
 * 를 계산한다. UI·렌더링과 무관한 순수 함수이며 난수를 쓰지 않는다.
 *
 * 기하 모델 (모든 길이 m)
 *   minPitch     = product.height + liftClearance + beamThickness
 *   pitch        = (totalHeight − firstShelfHeight) / levels
 *   shelf(i)     = firstShelfHeight + (i − 1) · pitch          i = 1..levels
 *   totalHeight  = firstShelfHeight + levels · pitch           (상부 빔 포함)
 *   rackTopLimit = spaceClearHeight − ceilingClearance
 *
 * 검사
 *   pitch        : pitch ≥ minPitch                     제품이 단 사이에 들어가는가
 *   ceiling      : totalHeight ≤ rackTopLimit           천장 이격
 *   robotReach   : workSurfaceMin ≤ shelf(i) ≤ workSurfaceMax  (모든 단)
 *   robotOverall : robot.overallHeight ≤ spaceClearHeight
 *
 * 경계값(같음)은 통과로 판정한다 (허용 오차 EPS = 0.001 mm).
 */
import type {
  BindingConstraint,
  CheckResult,
  LevelResult,
  LevelScanRow,
  MaxLevelsResult,
  RackVerticalInput,
  RackVerticalResult,
  ValidationIssue,
} from "./types";
import { EPS, gte, lte, toMm } from "./units";
import { hasErrors, validateInput } from "./validate";

export const ENGINE_NAME = "ctu-rack-vertical";
export const ENGINE_VERSION = "0.1.1";

const fmtMm = (m: number) =>
  `${Math.round(toMm(m)).toLocaleString("ko-KR")} mm`;
const fmtMm1 = (m: number) =>
  `${(Math.round(toMm(m) * 10) / 10).toLocaleString("ko-KR")} mm`;

type RackGeometryInput = Pick<
  RackVerticalInput,
  "product" | "assumptions" | "rack"
>;
type RackPitchInput = Pick<RackVerticalInput, "product" | "assumptions">;

export function minPitch(input: RackPitchInput): number {
  const a = input.assumptions;
  return input.product.height + a.liftClearance + a.beamThickness;
}

/** 단수 n의 최소 랙 높이 [m] */
export function minTotalHeight(input: RackPitchInput, levels: number): number {
  return input.assumptions.firstShelfHeight + levels * minPitch(input);
}

/** Shared authoritative rack geometry, independent of robot/building inputs. */
export function resolveRackGeometry(input: RackGeometryInput): {
  pitch: number;
  totalHeight: number;
  minPitch: number;
  topShelfHeight: number;
  topLoadHeight: number;
  clearanceAbove: number;
} {
  const a = input.assumptions;
  const pitchMinimum = minPitch(input);
  const totalHeight =
    input.rack.totalHeight ??
    a.firstShelfHeight + input.rack.levels * pitchMinimum;
  const pitch = (totalHeight - a.firstShelfHeight) / input.rack.levels;
  const topShelfHeight = a.firstShelfHeight + (input.rack.levels - 1) * pitch;
  return {
    pitch,
    totalHeight,
    minPitch: pitchMinimum,
    topShelfHeight,
    topLoadHeight: topShelfHeight + input.product.height,
    clearanceAbove: pitch - a.beamThickness - input.product.height,
  };
}

function assertValid(input: RackVerticalInput): void {
  const errors = validateInput(input).filter((i) => i.severity === "error");
  if (errors.length)
    throw new Error(errors.map((i) => `${i.field}: ${i.message}`).join("\n"));
}

/** 공간·로봇 조건에서 가능한 최대 단수 (최소 피치 기준) */
export function computeMaxLevels(input: RackVerticalInput): MaxLevelsResult {
  assertValid(input);
  const p = minPitch(input);
  const base = input.assumptions.firstShelfHeight;
  const { workSurfaceMax, workSurfaceMin } = input.robot;
  const rackTopLimit =
    input.spaceClearHeight - input.assumptions.ceilingClearance;

  // EPS is a length tolerance in metres. Apply it before division by pitch.
  const bySpace = Math.max(0, Math.floor((rackTopLimit - base + EPS) / p));
  const robotCanReachFirst =
    gte(base, workSurfaceMin) && lte(base, workSurfaceMax);
  // Work range alone cannot establish feasibility if the raised robot cannot fit in the room.
  const robotFitsSpace = lte(input.robot.overallHeight, input.spaceClearHeight);
  const byRobot =
    robotCanReachFirst && robotFitsSpace
      ? Math.max(0, Math.floor((workSurfaceMax - base + EPS) / p) + 1)
      : 0;
  const max = Math.min(bySpace, byRobot);
  const binding: BindingConstraint =
    bySpace < byRobot ? "space" : byRobot < bySpace ? "robot" : "both";

  return {
    bySpace,
    byRobot,
    max,
    binding,
    spaceHeightForNext: Math.max(
      input.robot.overallHeight,
      base + (max + 1) * p + input.assumptions.ceilingClearance,
    ),
    workSurfaceMaxForNext: base + max * p,
  };
}

/** 검증을 통과한 입력에 대해 검토 랙을 평가한다. */
export function evaluate(input: RackVerticalInput): RackVerticalResult {
  assertValid(input);
  const a = input.assumptions;
  const n = input.rack.levels;
  const geometry = resolveRackGeometry(input);
  const pMin = geometry.minPitch;
  const auto = input.rack.totalHeight === undefined;
  const H = geometry.totalHeight;
  const pitch = geometry.pitch;
  const rackTopLimit = input.spaceClearHeight - a.ceilingClearance;
  const { workSurfaceMax, workSurfaceMin, overallHeight } = input.robot;

  const levelDetails: LevelResult[] = [];
  for (let i = 1; i <= n; i++) {
    const shelf = a.firstShelfHeight + (i - 1) * pitch;
    const reach = !lte(shelf, workSurfaceMax)
      ? "tooHigh"
      : !gte(shelf, workSurfaceMin)
        ? "tooLow"
        : "ok";
    levelDetails.push({
      index: i,
      shelfHeight: shelf,
      productTop: shelf + input.product.height,
      clearanceAbove: pitch - a.beamThickness - input.product.height,
      reach,
    });
  }

  const first = levelDetails[0];
  const top = levelDetails[n - 1];
  const anyHigh = levelDetails.some((l) => l.reach === "tooHigh");
  const anyLow = levelDetails.some((l) => l.reach === "tooLow");
  const reachValue = anyHigh || !anyLow ? top.shelfHeight : first.shelfHeight;
  const reachLimit = anyHigh || !anyLow ? workSurfaceMax : workSurfaceMin;

  const checks: CheckResult[] = [
    {
      id: "pitch",
      pass: gte(pitch, pMin),
      value: pitch,
      limit: pMin,
      message: `단 피치 ${fmtMm1(pitch)} / 최소 ${fmtMm1(pMin)}`,
    },
    {
      id: "ceiling",
      pass: lte(H, rackTopLimit),
      value: H,
      limit: rackTopLimit,
      message: `랙 높이 ${fmtMm(H)} / 한계 ${fmtMm(rackTopLimit)}`,
    },
    {
      id: "robotReach",
      pass: !anyHigh && !anyLow,
      value: reachValue,
      limit: reachLimit,
      message: `선반면 ${fmtMm(first.shelfHeight)}~${fmtMm(top.shelfHeight)} / 작업 범위 ${fmtMm(workSurfaceMin)}~${fmtMm(workSurfaceMax)}`,
    },
    {
      id: "robotOverall",
      pass: lte(overallHeight, input.spaceClearHeight),
      value: overallHeight,
      limit: input.spaceClearHeight,
      message: `로봇 전고 ${fmtMm(overallHeight)} / 공간 ${fmtMm(input.spaceClearHeight)}`,
    },
  ];

  return {
    feasible: checks.every((c) => c.pass),
    levels: n,
    totalHeight: H,
    totalHeightIsMinimum: auto,
    pitch,
    minPitch: pMin,
    rackTopLimit,
    headroom: input.spaceClearHeight - H,
    checks,
    levelDetails,
    maxLevels: computeMaxLevels(input),
  };
}

/** 1단부터 upTo단까지 최소 랙 높이 기준 가능 여부를 나열한다. */
export function scanLevels(
  input: RackVerticalInput,
  upTo?: number,
): LevelScanRow[] {
  assertValid(input);
  if (
    upTo !== undefined &&
    (!Number.isSafeInteger(upTo) || upTo < 1 || upTo > 100)
  )
    throw new RangeError("스캔 상한은 1~100의 정수여야 합니다.");
  const limit =
    upTo ??
    Math.min(
      100,
      Math.max(computeMaxLevels(input).max + 2, input.rack.levels + 1, 3),
    );
  const rows: LevelScanRow[] = [];
  for (let n = 1; n <= limit; n++) {
    const r = evaluate({ ...input, rack: { levels: n } });
    const ok = (id: string) => r.checks.find((c) => c.id === id)!.pass;
    rows.push({
      levels: n,
      minTotalHeight: r.totalHeight,
      ceilingPass: ok("ceiling"),
      robotPass: ok("robotReach") && ok("robotOverall"),
      feasible: r.feasible,
    });
  }
  return rows;
}

export interface SimulationRecord {
  engine: { name: string; version: string };
  /** 실행 시각 (ISO 8601). 결과 재현성과 무관한 메타데이터 */
  runAt: string;
  input: RackVerticalInput;
  issues: ValidationIssue[];
  result: RackVerticalResult | null;
  scan: LevelScanRow[];
}

/**
 * 검증 → 평가 → 단수 스캔을 한 번에 수행하고, 입력·엔진 버전을 함께 기록한 결과를 돌려준다.
 * (요구사항: 계산에 사용한 가정·모델·엔진 버전을 실행 결과에 기록)
 */
export function simulate(
  input: RackVerticalInput,
  now: Date = new Date(),
): SimulationRecord {
  const issues = validateInput(input);
  const ok = !hasErrors(issues);
  return {
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
    runAt: now.toISOString(),
    input,
    issues,
    result: ok ? evaluate(input) : null,
    scan: ok ? scanLevels(input) : [],
  };
}
