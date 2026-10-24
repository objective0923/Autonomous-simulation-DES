/** 길이 단위 변환. 내부 기본 단위는 m. */
import type { RackVerticalInput } from "./types";
import { validateInput } from "./validate";

/** mm → m */
export const mm = (valueMm: number): number => valueMm / 1000;

/** m → mm */
export const toMm = (valueM: number): number => valueM * 1000;

/**
 * 비교 허용 오차 [m] = 0.001 mm.
 * 경계값(예: 랙 상단 = 한계)은 통과로 판정하기 위해 사용한다.
 */
export const EPS = 1e-6;

export const lte = (a: number, b: number): boolean => a <= b + EPS;
export const gte = (a: number, b: number): boolean => a >= b - EPS;

/** 부동소수 오차를 흡수한 floor (예: 2.55/0.425 = 5.9999999 → 6) */
export const floorEps = (x: number): number => Math.floor(x + 1e-9);

/**
 * Import the user-supplied example-input.mm.json schema. Every length is explicit
 * *_mm (or an assumptions_mm member). SI/mixed/unknown keys and numeric strings
 * are rejected instead of guessed. No defaults are inserted for missing specs.
 */
export function parseMillimeterInput(input: unknown): RackVerticalInput {
  const object = (v: unknown, field: string): Record<string, unknown> => {
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new Error(`${field}: JSON 객체가 필요합니다.`);
    return v as Record<string, unknown>;
  };
  const keys = (
    r: Record<string, unknown>,
    allowed: string[],
    field: string,
  ) => {
    const unknown = Object.keys(r).filter((key) => !allowed.includes(key));
    if (unknown.length)
      throw new Error(
        `${field}: 지원하지 않는 필드 ${unknown.join(", ")}. mm 전용 형식과 m 형식을 섞지 마세요.`,
      );
  };
  const num = (
    r: Record<string, unknown>,
    key: string,
    field: string,
  ): number => {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key]))
      throw new Error(`${field}.${key}: 유한한 mm 숫자가 필요합니다.`);
    return r[key] as number;
  };
  const id = (r: Record<string, unknown>, field: string): { id?: string } => {
    if (r.id === undefined) return {};
    if (typeof r.id !== "string" || !r.id.trim())
      throw new Error(`${field}.id: 비어 있지 않은 문자열이 필요합니다.`);
    return { id: r.id };
  };
  const root = object(input, "input");
  keys(
    root,
    [
      "_note",
      "spaceClearHeight_mm",
      "product",
      "robot",
      "rack",
      "assumptions_mm",
    ],
    "input",
  );
  if (root._note !== undefined && typeof root._note !== "string")
    throw new Error("_note는 설명 문자열이어야 합니다.");
  const product = object(root.product, "product");
  const robot = object(root.robot, "robot");
  const rack = object(root.rack, "rack");
  const assumptions = object(root.assumptions_mm, "assumptions_mm");
  keys(product, ["id", "height_mm"], "product");
  keys(
    robot,
    ["id", "overallHeight_mm", "workSurfaceMax_mm", "workSurfaceMin_mm"],
    "robot",
  );
  keys(rack, ["levels", "totalHeight_mm"], "rack");
  keys(
    assumptions,
    ["firstShelfHeight", "liftClearance", "beamThickness", "ceilingClearance"],
    "assumptions_mm",
  );
  const output: RackVerticalInput = {
    spaceClearHeight: mm(num(root, "spaceClearHeight_mm", "input")),
    product: {
      ...id(product, "product"),
      height: mm(num(product, "height_mm", "product")),
    },
    robot: {
      ...id(robot, "robot"),
      overallHeight: mm(num(robot, "overallHeight_mm", "robot")),
      workSurfaceMax: mm(num(robot, "workSurfaceMax_mm", "robot")),
      workSurfaceMin: mm(num(robot, "workSurfaceMin_mm", "robot")),
    },
    rack: {
      levels: num(rack, "levels", "rack"),
      ...(rack.totalHeight_mm === undefined
        ? {}
        : { totalHeight: mm(num(rack, "totalHeight_mm", "rack")) }),
    },
    assumptions: {
      firstShelfHeight: mm(
        num(assumptions, "firstShelfHeight", "assumptions_mm"),
      ),
      liftClearance: mm(num(assumptions, "liftClearance", "assumptions_mm")),
      beamThickness: mm(num(assumptions, "beamThickness", "assumptions_mm")),
      ceilingClearance: mm(
        num(assumptions, "ceilingClearance", "assumptions_mm"),
      ),
    },
  };
  const errors = validateInput(output).filter((i) => i.severity === "error");
  if (errors.length)
    throw new Error(errors.map((i) => `${i.field}: ${i.message}`).join("\n"));
  return output;
}
