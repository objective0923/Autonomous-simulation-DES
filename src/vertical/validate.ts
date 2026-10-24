import type { ValidationIssue } from "./types";

const isNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * 입력 검증. severity 'error'가 하나라도 있으면 evaluate()를 호출하지 않는다.
 * 'warning'은 계산은 가능하지만 검토가 필요한 항목이다.
 * (요구사항 3번: 검사 결과의 오류와 검토 필요 사항을 구분)
 */
export function validateInput(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, field: string, message: string) =>
    issues.push({ severity: "error", code, field, message });
  const warn = (code: string, field: string, message: string) =>
    issues.push({ severity: "warning", code, field, message });

  if (!record(input))
    return [
      {
        severity: "error",
        code: "INVALID_INPUT",
        field: "",
        message: "입력은 JSON 객체여야 합니다.",
      },
    ];
  const product = record(input.product) ? input.product : {};
  const robot = record(input.robot) ? input.robot : {};
  const rack = record(input.rack) ? input.rack : {};
  const assumptions = record(input.assumptions) ? input.assumptions : {};
  for (const key of ["product", "robot", "rack", "assumptions"])
    if (!record(input[key]))
      err("INVALID_SECTION", key, `${key}는 객체여야 합니다.`);

  const lengths: Array<[string, unknown, boolean]> = [
    // [경로, 값, 0 허용 여부]
    ["spaceClearHeight", input.spaceClearHeight, false],
    ["product.height", product.height, false],
    ["robot.overallHeight", robot.overallHeight, false],
    ["robot.workSurfaceMax", robot.workSurfaceMax, false],
    ["robot.workSurfaceMin", robot.workSurfaceMin, true],
    ["assumptions.firstShelfHeight", assumptions.firstShelfHeight, true],
    ["assumptions.liftClearance", assumptions.liftClearance, true],
    ["assumptions.beamThickness", assumptions.beamThickness, true],
    ["assumptions.ceilingClearance", assumptions.ceilingClearance, true],
  ];
  for (const [field, v, allowZero] of lengths) {
    if (!isNum(v)) err("NOT_A_NUMBER", field, `${field} 값이 숫자가 아닙니다.`);
    else if (v < 0 || (!allowZero && v === 0))
      err(
        "OUT_OF_RANGE",
        field,
        `${field} 값은 ${allowZero ? "0 이상" : "0보다 커야"} 합니다.`,
      );
  }

  const lv = rack.levels;
  if (!isNum(lv) || !Number.isSafeInteger(lv) || lv < 1 || lv > 100)
    err("INVALID_LEVELS", "rack.levels", "단수는 1~100의 정수여야 합니다.");

  const th = rack.totalHeight;
  if (th !== undefined) {
    if (!isNum(th) || th <= 0)
      err("OUT_OF_RANGE", "rack.totalHeight", "랙 높이는 0보다 커야 합니다.");
    else if (
      isNum(assumptions.firstShelfHeight) &&
      th <= assumptions.firstShelfHeight
    )
      err(
        "RACK_BELOW_FIRST_SHELF",
        "rack.totalHeight",
        "랙 높이가 1단 선반면보다 낮습니다.",
      );
  }

  if (issues.some((i) => i.severity === "error")) return issues;

  const pitch =
    (product.height as number) +
    (assumptions.liftClearance as number) +
    (assumptions.beamThickness as number);
  const minimumHeight =
    (assumptions.firstShelfHeight as number) + (lv as number) * pitch;
  const bySpaceRatio =
    ((input.spaceClearHeight as number) -
      (assumptions.ceilingClearance as number) -
      (assumptions.firstShelfHeight as number) +
      1e-6) /
    pitch;
  const byRobotRatio =
    ((robot.workSurfaceMax as number) -
      (assumptions.firstShelfHeight as number) +
      1e-6) /
    pitch;
  if (
    !Number.isFinite(pitch) ||
    !Number.isFinite(minimumHeight) ||
    !Number.isSafeInteger(Math.floor(bySpaceRatio)) ||
    !Number.isSafeInteger(Math.floor(byRobotRatio))
  )
    err(
      "CALCULATION_RANGE",
      "assumptions",
      "치수 계산이 유한한 정수 단수의 수치 범위를 초과합니다. 단위와 입력 크기를 확인하세요.",
    );

  if ((robot.workSurfaceMin as number) >= (robot.workSurfaceMax as number))
    err(
      "WORK_RANGE_INVERTED",
      "robot.workSurfaceMin",
      "최저 작업면은 최고 작업면보다 낮아야 합니다.",
    );
  if ((robot.workSurfaceMax as number) > (robot.overallHeight as number))
    err(
      "WORK_ABOVE_ROBOT",
      "robot.workSurfaceMax",
      "최고 작업면이 로봇 전고보다 높습니다.",
    );

  if (assumptions.liftClearance === 0)
    warn(
      "ZERO_LIFT_CLEARANCE",
      "assumptions.liftClearance",
      "들어올림 여유가 0입니다. 로봇 포크·트레이 진입 공간을 확인하세요.",
    );
  if (assumptions.ceilingClearance === 0)
    warn(
      "ZERO_CEILING_CLEARANCE",
      "assumptions.ceilingClearance",
      "천장 이격이 0입니다. 스프링클러·조명 기준을 확인하세요.",
    );

  return issues;
}

export const hasErrors = (issues: ValidationIssue[]) =>
  issues.some((i) => i.severity === "error");
