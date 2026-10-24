import type { MapObject, SpacePlan, ValidationIssue } from "./types";
import {
  evaluate,
  resolveRackGeometry,
  validateInput,
  type RackVerticalInput,
} from "./vertical";

export type PlanningStatus = "pass" | "fail" | "needsReview";
export interface RackCheck {
  code: string;
  label: string;
  status: PlanningStatus;
  message: string;
}
export interface RackComparison {
  levels: number;
  topShelfHeight: number;
  topLoadHeight: number;
  requiredClearHeight: number;
  requiredLiftHeight: number;
  pitch: number;
  totalHeight: number;
  minPitch: number;
  clearanceAbove: number;
  headroom: number | null;
  status: PlanningStatus;
  checks: RackCheck[];
}
export interface VerticalGeometry {
  pitch: number;
  totalHeight: number;
  minPitch: number;
  topShelfHeight: number;
  topLoadHeight: number;
  clearanceAbove: number;
}
export interface VerticalCapacity {
  byHeight: number | null;
  byLift: number | null;
  max: number | null;
  binding: "space" | "robot" | "both" | "unknown";
  basis: "fixedPitch" | "fixedTotalHeight" | "minimumPitch";
  spaceHeightForNext: number | null;
  workSurfaceMaxForNext: number | null;
  liftHeightForNext: number | null;
}
export interface LayoutProposal {
  placements: SpacePlan["layout"]["placements"];
  orientation: 0 | 90;
  capacity5: number;
  capacity6: number;
  levels: number;
  capacityUnits: number;
  maxLevelsByHeight: number | null;
  maxLevelsByLift: number | null;
  candidateCount: number;
  issues: string[];
  status: "provisional" | "verified";
  assumptions: string[];
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const evidence = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
const EPS = 1e-8;
const rounded = (n: number) => Math.round(n * 1e9) / 1e9;
const safeId = (v: unknown): v is string =>
  evidence(v) && v !== "prototype" && !Object.hasOwn(Object.prototype, v);

/** Draft values are examples only. Real robot geometry is deliberately unknown. */
export function createSpacePlan(): SpacePlan {
  return {
    calibration: {
      referencePixels: null,
      referenceMeters: null,
      confirmed: false,
      evidence: "",
    },
    building: {
      width: 40,
      depth: 24,
      clearHeight: null,
      confirmed: false,
      evidence: "",
    },
    robot: {
      kind: "ctu",
      width: null,
      length: null,
      minAisleWidth: null,
      minTransferHeight: null,
      maxLiftHeight: null,
      overallHeight: null,
      firstShelfHeight: null,
      shelfPitch: null,
      shelfCount: null,
      transferMode: "liftRange",
      alignmentTolerance: 0.01,
      maxPayloadKg: null,
      confirmed: false,
      evidence: "",
    },
    rack: {
      width: 1.2,
      depth: 1.1,
      firstShelfHeight: 0.45,
      shelfPitch: 1.1,
      loadHeight: 0.85,
      topClearance: 0.3,
      liftClearance: 0.1,
      beamThickness: 0.05,
      heightMode: "pitch",
      totalHeight: null,
      unitLoadKg: 300,
      shelfCapacityKg: 500,
      confirmed: false,
      evidence: "",
    },
    layout: {
      margin: 0.6,
      crossAisle: 2.5,
      requestedLevels: 5,
      placements: [],
    },
  };
}

/** Strict, nonthrowing validation for imported optional planning metadata. Units are SI. */
export function validateSpacePlan(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (
    code: string,
    message: string,
    severity: "error" | "warning" = "error",
  ) => issues.push({ code, message, severity, entityId: "spacePlan" });
  if (!record(input))
    return [
      {
        code: "PLAN_OBJECT",
        message: "spacePlan은 사전 설계 객체여야 합니다.",
        severity: "error",
        entityId: "spacePlan",
      },
    ];
  const sections: Record<string, Record<string, unknown>> = {};
  for (const section of [
    "calibration",
    "building",
    "robot",
    "rack",
    "layout",
  ]) {
    if (!record(input[section]))
      add("PLAN_SECTION", `spacePlan.${section}: 객체가 필요합니다.`);
    else sections[section] = input[section] as Record<string, unknown>;
  }
  const number = (
    r: Record<string, unknown>,
    key: string,
    label: string,
    nullable = false,
    zero = false,
  ) => {
    const value = r[key];
    if (nullable && value === null) return;
    if (!finite(value) || (zero ? value < 0 : value <= 0))
      add(
        "PLAN_NUMBER",
        `${label}: ${zero ? "0 이상" : "0 초과"}의 유한한 ${nullable ? "값 또는 null" : "값"}이 필요합니다. 길이는 m, 질량은 kg입니다.`,
      );
  };
  const confirmation = (
    r: Record<string, unknown>,
    label: string,
    required: string[],
  ) => {
    if (typeof r.confirmed !== "boolean")
      add("PLAN_CONFIRMATION", `${label}.confirmed: true/false가 필요합니다.`);
    if (typeof r.evidence !== "string")
      add("PLAN_EVIDENCE", `${label}.evidence: 검증 근거 문자열이 필요합니다.`);
    if (r.confirmed === true) {
      if (!evidence(r.evidence))
        add(
          "PLAN_FALSE_CONFIRMATION",
          `${label}: 확인 상태에는 비어 있지 않은 검증 근거가 필요합니다.`,
        );
      for (const key of required)
        if (!finite(r[key]))
          add(
            "PLAN_FALSE_CONFIRMATION",
            `${label}: ${key}의 실제 수치가 없으므로 확인 완료로 저장할 수 없습니다.`,
          );
    }
  };
  const calibration = sections.calibration;
  if (calibration) {
    number(calibration, "referencePixels", "기준선 픽셀 길이", true);
    number(calibration, "referenceMeters", "기준선 실제 길이", true);
    confirmation(calibration, "축척", ["referencePixels", "referenceMeters"]);
    if (calibration.confirmed === true && !record(input.source))
      add(
        "PLAN_FALSE_CONFIRMATION",
        "축척 확인에는 원본 도면 페이지가 필요합니다.",
      );
    if (calibration.points !== undefined) {
      const points = calibration.points;
      if (
        !Array.isArray(points) ||
        points.length !== 2 ||
        points.some(
          (point) =>
            !record(point) ||
            !finite(point.x) ||
            !finite(point.y) ||
            point.x < 0 ||
            point.y < 0,
        )
      )
        add(
          "PLAN_CALIBRATION_POINTS",
          "도면 기준선은 유한한 0 이상 픽셀 좌표로 구성된 정확히 두 끝점이어야 합니다.",
        );
      else {
        const [a, b] = points as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        if (
          !record(input.source) ||
          !positive(input.source.widthPx) ||
          !positive(input.source.heightPx)
        )
          add(
            "PLAN_CALIBRATION_SOURCE",
            "기준선 끝점은 원본 도면의 픽셀 경계와 함께 저장해야 합니다.",
          );
        else if (
          points.some(
            (point) =>
              (point as { x: number; y: number }).x >
                (input.source as Record<string, number>).widthPx + EPS ||
              (point as { x: number; y: number }).y >
                (input.source as Record<string, number>).heightPx + EPS,
          )
        )
          add(
            "PLAN_CALIBRATION_BOUNDS",
            "도면 기준선 끝점이 원본 이미지 픽셀 경계를 벗어납니다.",
          );
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        const tolerance = Math.max(0.01, distance * 1e-6);
        if (
          !positive(calibration.referencePixels) ||
          distance <= EPS ||
          Math.abs(distance - calibration.referencePixels) > tolerance
        )
          add(
            "PLAN_CALIBRATION_DISTANCE",
            "기준선 끝점의 픽셀 거리와 referencePixels가 일치해야 합니다.",
          );
      }
    }
  }
  const building = sections.building;
  if (building) {
    number(building, "width", "건물 폭");
    number(building, "depth", "건물 깊이");
    number(building, "clearHeight", "건물 유효 높이", true);
    confirmation(building, "건물 경계", ["width", "depth", "clearHeight"]);
  }
  const robot = sections.robot;
  if (robot) {
    if (!["ctu", "lowProfile", "pallet"].includes(String(robot.kind)))
      add(
        "PLAN_ROBOT_KIND",
        "로봇 종류는 ctu, lowProfile, pallet 중 하나여야 합니다.",
      );
    for (const key of [
      "width",
      "length",
      "minAisleWidth",
      "maxPayloadKg",
      "overallHeight",
    ])
      number(robot, key, `로봇 ${key}`, true);
    for (const key of ["minTransferHeight", "firstShelfHeight"])
      number(robot, key, `로봇 ${key}`, true, true);
    number(robot, "maxLiftHeight", "로봇 최대 인계 높이", true, true);
    number(robot, "shelfPitch", "로봇 선반 피치", true);
    if (
      robot.shelfCount !== null &&
      (!Number.isSafeInteger(robot.shelfCount) ||
        (robot.shelfCount as number) < 1 ||
        (robot.shelfCount as number) > 100)
    )
      add(
        "PLAN_ROBOT_SHELF_COUNT",
        "로봇 선반 수는 1~100의 정수 또는 null이어야 합니다.",
      );
    if (
      robot.transferMode !== "liftRange" &&
      robot.transferMode !== "fixedLevels"
    )
      add(
        "PLAN_TRANSFER_MODE",
        "로봇 인계 모드는 liftRange 또는 fixedLevels여야 합니다.",
      );
    number(robot, "alignmentTolerance", "인계 높이 정렬 허용오차", false, true);
    if (
      finite(robot.minTransferHeight) &&
      finite(robot.maxLiftHeight) &&
      robot.minTransferHeight > robot.maxLiftHeight
    )
      add(
        "PLAN_TRANSFER_RANGE",
        "최소 인계 높이는 최대 인계 높이보다 클 수 없습니다.",
      );
    if (
      finite(robot.overallHeight) &&
      finite(robot.maxLiftHeight) &&
      robot.maxLiftHeight > robot.overallHeight + EPS
    )
      add(
        "PLAN_ROBOT_WORK_ABOVE_BODY",
        "로봇 최대 작업면이 최대 상승 전고보다 높을 수 없습니다.",
      );
    confirmation(robot, "로봇 사양", [
      "width",
      "length",
      "minAisleWidth",
      "maxPayloadKg",
      "overallHeight",
      ...(robot.kind === "ctu" ? ["minTransferHeight", "maxLiftHeight"] : []),
      ...(robot.transferMode === "fixedLevels"
        ? ["firstShelfHeight", "shelfPitch", "shelfCount"]
        : []),
    ]);
  }
  const rack = sections.rack;
  if (rack) {
    for (const key of ["width", "depth", "shelfPitch", "loadHeight"])
      number(rack, key, `랙 ${key}`);
    for (const key of [
      "firstShelfHeight",
      "topClearance",
      "liftClearance",
      "beamThickness",
      "unitLoadKg",
      "shelfCapacityKg",
    ])
      number(rack, key, `랙 ${key}`, false, true);
    number(rack, "totalHeight", "랙 전체 구조 높이", true);
    if (!["pitch", "totalHeight", "minimum"].includes(String(rack.heightMode)))
      add(
        "PLAN_HEIGHT_MODE",
        "랙 높이 모드는 pitch, totalHeight, minimum 중 하나여야 합니다.",
      );
    if (
      rack.heightMode === "totalHeight" &&
      (!positive(rack.totalHeight) ||
        (finite(rack.firstShelfHeight) &&
          rack.totalHeight <= rack.firstShelfHeight))
    )
      add(
        "PLAN_TOTAL_HEIGHT",
        "전체 높이 모드는 1단 선반면보다 높은 실제 구조 전체 높이가 필요합니다.",
      );
    confirmation(rack, "랙 사양", [
      "width",
      "depth",
      "firstShelfHeight",
      "shelfPitch",
      "loadHeight",
      "topClearance",
      "liftClearance",
      "beamThickness",
      "unitLoadKg",
      "shelfCapacityKg",
      ...(rack.heightMode === "totalHeight" ? ["totalHeight"] : []),
    ]);
  }
  const layout = sections.layout;
  if (layout) {
    number(layout, "margin", "경계 여유", false, true);
    number(layout, "crossAisle", "횡단 통로 폭");
    if (
      !Number.isSafeInteger(layout.requestedLevels) ||
      (layout.requestedLevels as number) < 1 ||
      (layout.requestedLevels as number) > 100
    )
      add("PLAN_LEVELS", "랙 단수는 1~100의 정수여야 합니다.");
    if (!Array.isArray(layout.placements))
      add("PLAN_PLACEMENTS", "자동배치 결과는 배열이어야 합니다.");
    else {
      if (layout.placements.length > 20_000)
        add(
          "PLAN_LAYOUT_LIMIT",
          "자동배치 결과는 최대 20,000개까지 지원합니다.",
        );
      const ids = new Set<string>();
      for (const entry of layout.placements) {
        if (!record(entry)) {
          add("PLAN_PLACEMENT", "각 랙 배치는 객체여야 합니다.");
          continue;
        }
        if (!safeId(entry.id) || ids.has(entry.id))
          add(
            "PLAN_PLACEMENT_ID",
            "랙 배치 ID는 고유하고 객체 예약 키가 아닌 문자열이어야 합니다.",
          );
        else ids.add(entry.id);
        number(entry, "x", "랙 중심 x", false, true);
        number(entry, "y", "랙 중심 y", false, true);
        number(entry, "width", "배치 랙 폭");
        number(entry, "depth", "배치 랙 깊이");
        if (entry.rotation !== 0 && entry.rotation !== 90)
          add(
            "PLAN_ROTATION",
            "자동배치 랙 회전은 0도 또는 90도만 지원합니다.",
          );
        if (
          building &&
          [
            entry.x,
            entry.y,
            entry.width,
            entry.depth,
            building.width,
            building.depth,
          ].every(finite) &&
          [0, 90].includes(Number(entry.rotation))
        ) {
          const width =
            entry.rotation === 90
              ? (entry.depth as number)
              : (entry.width as number);
          const depth =
            entry.rotation === 90
              ? (entry.width as number)
              : (entry.depth as number);
          if (
            (entry.x as number) - width / 2 < -EPS ||
            (entry.y as number) - depth / 2 < -EPS ||
            (entry.x as number) + width / 2 >
              (building.width as number) + EPS ||
            (entry.y as number) + depth / 2 > (building.depth as number) + EPS
          )
            add(
              "PLAN_OUT_OF_BOUNDS",
              `"${String(entry.id)}" 랙이 직사각형 건물 경계를 벗어납니다.`,
            );
        }
        if (
          rack &&
          finite(rack.width) &&
          finite(rack.depth) &&
          finite(entry.width) &&
          finite(entry.depth) &&
          (Math.abs(entry.width - rack.width) > EPS ||
            Math.abs(entry.depth - rack.depth) > EPS)
        )
          add(
            "PLAN_LAYOUT_STALE",
            "배치 결과의 랙 치수가 현재 사양과 다릅니다. 자동배치를 다시 생성하세요.",
            "warning",
          );
      }
    }
  }
  if (input.source !== undefined) {
    if (!record(input.source))
      add("PLAN_SOURCE", "원본 도면 메타데이터는 객체여야 합니다.");
    else {
      const source = input.source;
      if (!evidence(source.name))
        add("PLAN_SOURCE_NAME", "원본 도면 파일명이 필요합니다.");
      if (source.type !== "image" && source.type !== "pdf")
        add("PLAN_SOURCE_TYPE", "도면 종류는 image 또는 pdf여야 합니다.");
      if (
        !Number.isSafeInteger(source.page) ||
        (source.page as number) < 1 ||
        (source.page as number) > 100
      )
        add("PLAN_SOURCE_PAGE", "원본 페이지 번호는 1~100의 정수여야 합니다.");
      for (const key of ["widthPx", "heightPx"])
        if (!Number.isSafeInteger(source[key]) || (source[key] as number) <= 0)
          add("PLAN_SOURCE_SIZE", "도면 픽셀 치수는 양의 정수여야 합니다.");
      if (
        typeof source.dataUrl !== "string" ||
        !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/.test(
          source.dataUrl,
        )
      )
        add(
          "PLAN_SOURCE_IMAGE",
          "도면 페이지는 렌더링된 PNG/JPG data URL이어야 합니다. PDF 원본은 저장하지 않습니다.",
        );
      else if (source.dataUrl.length > 12 * 1024 * 1024)
        add(
          "PLAN_SOURCE_LIMIT",
          "도면 페이지 data URL은 최대 12 MiB까지 지원합니다.",
        );
    }
  }
  if (input.units !== undefined)
    add(
      "PLAN_UNITS",
      "별도 단위 메타데이터는 지원하지 않습니다. 계획 치수는 m, 질량은 kg로 변환하여 입력하세요.",
    );
  if (!issues.some((i) => i.severity === "error")) {
    const geometry = resolveVerticalGeometry(
      input as unknown as SpacePlan,
      layout!.requestedLevels as number,
    );
    if (
      Object.values(geometry).some((value) => !finite(value)) ||
      geometry.minPitch <= 0
    )
      add(
        "PLAN_VERTICAL_CALCULATION_RANGE",
        "랙 높이 계산이 유한한 수치 범위를 벗어납니다. 치수와 단위를 확인하세요.",
      );
  }
  if (!issues.some((i) => i.severity === "error") && robot?.kind === "ctu") {
    const vertical = coreInput(
      input as unknown as SpacePlan,
      layout?.requestedLevels as number,
    );
    if (vertical)
      for (const issue of validateInput(vertical)) {
        if (issue.severity === "error")
          add(
            `PLAN_VERTICAL_${issue.code}`,
            `${issue.field}: ${issue.message}`,
          );
      }
  }
  return issues;
}

const confirmed = (section: { confirmed: boolean; evidence: string }) =>
  section.confirmed && evidence(section.evidence);
function allConfirmed(plan: SpacePlan): boolean {
  return (
    !!plan.source &&
    confirmed(plan.calibration) &&
    positive(plan.calibration.referencePixels) &&
    positive(plan.calibration.referenceMeters) &&
    confirmed(plan.building) &&
    confirmed(plan.robot) &&
    confirmed(plan.rack)
  );
}

function geometryInput(
  plan: SpacePlan,
  levels: number,
): Pick<RackVerticalInput, "product" | "assumptions" | "rack"> {
  const r = plan.rack;
  const totalHeight =
    r.heightMode === "minimum"
      ? undefined
      : r.heightMode === "totalHeight"
        ? (r.totalHeight ?? NaN)
        : r.firstShelfHeight + levels * r.shelfPitch;
  return {
    product: { height: r.loadHeight },
    assumptions: {
      firstShelfHeight: r.firstShelfHeight,
      liftClearance: r.liftClearance,
      beamThickness: r.beamThickness,
      ceilingClearance: r.topClearance,
    },
    rack: { levels, ...(totalHeight === undefined ? {} : { totalHeight }) },
  };
}

/** One authoritative geometry formula shared with the supplied vertical module. */
export function resolveVerticalGeometry(
  plan: SpacePlan,
  levels = plan.layout.requestedLevels,
): VerticalGeometry {
  const geometry = resolveRackGeometry(geometryInput(plan, levels));
  return Object.fromEntries(
    Object.entries(geometry).map(([key, value]) => [key, rounded(value)]),
  ) as unknown as VerticalGeometry;
}

function coreInput(plan: SpacePlan, levels: number): RackVerticalInput | null {
  const robot = plan.robot;
  if (
    ![
      plan.building.clearHeight,
      robot.overallHeight,
      robot.minTransferHeight,
      robot.maxLiftHeight,
    ].every(finite)
  )
    return null;
  return {
    ...geometryInput(plan, levels),
    spaceClearHeight: plan.building.clearHeight!,
    robot: {
      overallHeight: robot.overallHeight!,
      workSurfaceMin: robot.minTransferHeight!,
      workSurfaceMax: robot.maxLiftHeight!,
    },
  };
}

function fixedMappingFits(
  plan: SpacePlan,
  levels: number,
  pitch: number,
): boolean | null {
  const robot = plan.robot;
  if (robot.transferMode !== "fixedLevels") return true;
  if (
    !finite(robot.firstShelfHeight) ||
    !positive(robot.shelfPitch) ||
    !finite(robot.shelfCount)
  )
    return null;
  if (levels > robot.shelfCount) return false;
  for (let level = 1; level <= levels; level++)
    if (
      Math.abs(
        robot.firstShelfHeight +
          (level - 1) * robot.shelfPitch -
          (plan.rack.firstShelfHeight + (level - 1) * pitch),
      ) >
      robot.alignmentTolerance + EPS
    )
      return false;
  return true;
}

/** Bounded 1..100 scan using the selected height mode, never an implicit minimum-pitch substitution. */
export function verticalCapacity(plan: SpacePlan): VerticalCapacity {
  const basis =
    plan.rack.heightMode === "minimum"
      ? "minimumPitch"
      : plan.rack.heightMode === "totalHeight"
        ? "fixedTotalHeight"
        : "fixedPitch";
  const result: VerticalCapacity = {
    byHeight: null,
    byLift: null,
    max: null,
    binding: "unknown",
    basis,
    spaceHeightForNext: null,
    workSurfaceMaxForNext: null,
    liftHeightForNext: null,
  };
  const inputs = { ...plan, layout: { ...plan.layout, placements: [] } };
  if (validateSpacePlan(inputs).some((i) => i.severity === "error"))
    return result;
  const robot = plan.robot;
  const knownHeight = positive(plan.building.clearHeight);
  const knownRobot =
    robot.kind === "ctu" &&
    positive(robot.overallHeight) &&
    finite(robot.minTransferHeight) &&
    positive(robot.maxLiftHeight) &&
    knownHeight &&
    (robot.transferMode !== "fixedLevels" ||
      (finite(robot.firstShelfHeight) &&
        positive(robot.shelfPitch) &&
        finite(robot.shelfCount)));
  const heightCandidates: number[] = [];
  const robotCandidates: number[] = [];
  for (let levels = 1; levels <= 100; levels++) {
    const geometry = resolveVerticalGeometry(plan, levels);
    if (Object.values(geometry).some((value) => !finite(value))) continue;
    const fitsPitch = geometry.pitch + EPS >= geometry.minPitch;
    if (
      knownHeight &&
      fitsPitch &&
      geometry.totalHeight + plan.rack.topClearance <=
        plan.building.clearHeight! + EPS
    )
      heightCandidates.push(levels);
    if (
      knownRobot &&
      fitsPitch &&
      robot.overallHeight! <= plan.building.clearHeight! + EPS &&
      robot.minTransferHeight! <= plan.rack.firstShelfHeight + EPS &&
      geometry.topShelfHeight + plan.rack.liftClearance <=
        robot.maxLiftHeight! + EPS &&
      fixedMappingFits(plan, levels, geometry.pitch) === true
    )
      robotCandidates.push(levels);
  }
  if (knownHeight) result.byHeight = heightCandidates.at(-1) ?? 0;
  if (knownRobot) result.byLift = robotCandidates.at(-1) ?? 0;
  if (result.byHeight === 0 || result.byLift === 0) result.max = 0;
  else if (result.byHeight !== null && result.byLift !== null)
    result.max =
      heightCandidates.filter((n) => robotCandidates.includes(n)).at(-1) ?? 0;
  if (result.byHeight !== null && result.byLift !== null)
    result.binding =
      result.max !== Math.min(result.byHeight, result.byLift)
        ? "both"
        : result.byHeight < result.byLift
          ? "space"
          : result.byLift < result.byHeight
            ? "robot"
            : "both";
  if (result.max !== null && result.max < 100) {
    const next = resolveVerticalGeometry(plan, result.max + 1);
    // Fixed total-height plans can require a larger structure when their pitch is too small.
    const minimumNextHeight =
      plan.rack.firstShelfHeight + (result.max + 1) * next.minPitch;
    const effectiveNextHeight = Math.max(next.totalHeight, minimumNextHeight);
    const nextPitch =
      (effectiveNextHeight - plan.rack.firstShelfHeight) / (result.max + 1);
    const nextTop = plan.rack.firstShelfHeight + result.max * nextPitch;
    result.spaceHeightForNext = rounded(
      Math.max(
        effectiveNextHeight + plan.rack.topClearance,
        robot.overallHeight ?? 0,
      ),
    );
    result.workSurfaceMaxForNext = rounded(nextTop);
    result.liftHeightForNext = rounded(nextTop + plan.rack.liftClearance);
  }
  return result;
}

/** Dimensional feasibility only; a pass is not structural or robot safety approval. */
export function compareRackLevels(
  plan: SpacePlan,
  levelsToCompare?: number[],
): RackComparison[] {
  const validation = validateSpacePlan(plan);
  return [
    ...new Set(levelsToCompare ?? [5, 6, plan.layout.requestedLevels]),
  ].map((levels) => {
    const r = plan.rack;
    const geometry = resolveVerticalGeometry(plan, levels);
    const { topShelfHeight, topLoadHeight } = geometry;
    const requiredClearHeight = rounded(geometry.totalHeight + r.topClearance);
    const requiredLiftHeight = rounded(topShelfHeight + r.liftClearance);
    const checks: RackCheck[] = [];
    const check = (
      code: string,
      label: string,
      status: PlanningStatus,
      message: string,
    ) => checks.push({ code, label, status, message });
    const validLevels =
      Number.isSafeInteger(levels) && levels >= 1 && levels <= 100;
    if (!validLevels)
      check(
        "LEVEL_COUNT",
        "비교 단수",
        "fail",
        "비교 단수는 1~100의 정수여야 합니다.",
      );
    if (validation.some((i) => i.severity === "error"))
      check(
        "VALID_INPUT",
        "입력 유효성",
        "fail",
        validation
          .filter((i) => i.severity === "error")
          .map((i) => i.message)
          .join(" "),
      );
    else
      check(
        "VALID_INPUT",
        "입력 유효성",
        "pass",
        "치수와 단위 형식이 유효합니다.",
      );
    const numberCheck = (
      code: string,
      label: string,
      actual: number | null,
      required: number,
      unit: string,
    ) => {
      if (!finite(actual))
        check(
          code,
          label,
          "needsReview",
          `실제 사양이 필요합니다. 요구 ${required.toFixed(3)} ${unit}.`,
        );
      else
        check(
          code,
          label,
          actual + EPS >= required ? "pass" : "fail",
          `입력 ${actual.toFixed(3)} ${unit} / 요구 ${required.toFixed(3)} ${unit}.`,
        );
    };
    numberCheck(
      "CLEAR_HEIGHT",
      "건물 유효 높이",
      plan.building.clearHeight,
      requiredClearHeight,
      "m",
    );
    if (
      !positive(plan.robot.overallHeight) ||
      !positive(plan.building.clearHeight)
    )
      check(
        "ROBOT_OVERALL",
        "로봇 최대 상승 전고",
        "needsReview",
        "로봇 최대 상승 전고와 공간 유효높이가 모두 필요합니다. 최대 작업면 높이와 전고는 별도 사양입니다.",
      );
    else
      check(
        "ROBOT_OVERALL",
        "로봇 최대 상승 전고",
        plan.robot.overallHeight <= plan.building.clearHeight + EPS
          ? "pass"
          : "fail",
        `로봇 전고 ${plan.robot.overallHeight.toFixed(3)} m / 공간 ${plan.building.clearHeight.toFixed(3)} m.`,
      );
    if (plan.robot.kind === "ctu") {
      const verticalInput = coreInput(plan, levels);
      if (verticalInput && validLevels) {
        const coreErrors = validateInput(verticalInput).filter(
          (i) => i.severity === "error",
        );
        if (coreErrors.length)
          check(
            "VERTICAL_CORE_INPUT",
            "수직 모듈 입력",
            "fail",
            coreErrors.map((i) => i.message).join(" "),
          );
        else {
          const core = evaluate(verticalInput);
          const reach = core.checks.find((c) => c.id === "robotReach")!;
          check(
            "WORK_SURFACE_RANGE",
            "공급 수직 모듈 작업면 범위",
            reach.pass ? "pass" : "fail",
            `${reach.message}. 아래 최대 인계 검사는 추가 상차 여유를 포함합니다.`,
          );
        }
      } else
        check(
          "WORK_SURFACE_RANGE",
          "공급 수직 모듈 작업면 범위",
          "needsReview",
          "건물 높이·로봇 전고·최소/최대 작업면의 실제 수치가 모두 있어야 수직 모듈을 평가합니다.",
        );
      numberCheck(
        "LIFT_HEIGHT",
        "CTU 최대 인계 높이",
        plan.robot.maxLiftHeight,
        requiredLiftHeight,
        "m",
      );
      if (!finite(plan.robot.minTransferHeight))
        check(
          "MIN_TRANSFER_HEIGHT",
          "CTU 최소 인계 높이",
          "needsReview",
          "최하단 랙 접근 여부를 확인하려면 로봇 최소 인계 높이가 필요합니다.",
        );
      else
        check(
          "MIN_TRANSFER_HEIGHT",
          "CTU 최소 인계 높이",
          plan.robot.minTransferHeight <= r.firstShelfHeight + EPS
            ? "pass"
            : "fail",
          `로봇 최소 ${plan.robot.minTransferHeight.toFixed(3)} m / 랙 최하단 ${r.firstShelfHeight.toFixed(3)} m.`,
        );
      if (plan.robot.transferMode === "fixedLevels") {
        numberCheck(
          "ROBOT_SHELF_COUNT",
          "로봇 고정 인계 단수",
          plan.robot.shelfCount,
          levels,
          "단",
        );
        if (
          !finite(plan.robot.firstShelfHeight) ||
          !positive(plan.robot.shelfPitch)
        )
          check(
            "FIXED_LEVEL_GEOMETRY",
            "로봇 고정 선반 치수",
            "needsReview",
            "고정 인계 모드는 로봇 첫 선반 높이와 선반 피치가 필요합니다.",
          );
      }
      if (validLevels)
        for (let level = 1; level <= levels; level++) {
          const rackHeight = rounded(
            r.firstShelfHeight + (level - 1) * geometry.pitch,
          );
          const liftHeight = rounded(rackHeight + r.liftClearance);
          const knownRange =
            finite(plan.robot.minTransferHeight) &&
            finite(plan.robot.maxLiftHeight);
          const withinRange =
            knownRange &&
            rackHeight + EPS >= plan.robot.minTransferHeight! &&
            liftHeight <= plan.robot.maxLiftHeight! + EPS;
          let status: PlanningStatus = knownRange
            ? withinRange
              ? "pass"
              : "fail"
            : "needsReview";
          let message = `랙 ${rackHeight.toFixed(3)} m, 상차 여유 포함 ${liftHeight.toFixed(3)} m.`;
          if (plan.robot.transferMode === "fixedLevels") {
            const knownShelf =
              finite(plan.robot.firstShelfHeight) &&
              positive(plan.robot.shelfPitch) &&
              finite(plan.robot.shelfCount);
            if (!knownShelf) {
              if (status !== "fail") status = "needsReview";
              message += " 로봇 고정 선반 치수가 필요합니다.";
            } else {
              const robotHeight = rounded(
                plan.robot.firstShelfHeight! +
                  (level - 1) * plan.robot.shelfPitch!,
              );
              const aligned =
                level <= plan.robot.shelfCount! &&
                Math.abs(robotHeight - rackHeight) <=
                  plan.robot.alignmentTolerance + EPS;
              if (!aligned) status = "fail";
              message += ` 로봇 ${robotHeight.toFixed(3)} m, 높이 차 ${Math.abs(robotHeight - rackHeight).toFixed(3)} m / 허용 ${plan.robot.alignmentTolerance.toFixed(3)} m.`;
            }
          } else
            message +=
              " 가변 마스트 방식은 로봇 선반 피치와 랙 피치의 일치를 강제하지 않습니다.";
          check(`TIER_${level}`, `${level}단 인계`, status, message);
        }
    } else
      check(
        "EXTERNAL_HANDOFF",
        "상단 랙 인계 설비",
        "needsReview",
        "저상형·팔레트 AMR은 상단 랙 직접 인계를 가정할 수 없습니다. 외부 리프트·컨베이어 등의 인계 설계가 필요합니다.",
      );
    numberCheck(
      "SHELF_PITCH",
      "선반 간 높이 여유·빔 포함",
      geometry.pitch,
      geometry.minPitch,
      "m",
    );
    numberCheck(
      "SHELF_LOAD",
      "선반 하중",
      r.shelfCapacityKg,
      r.unitLoadKg,
      "kg",
    );
    numberCheck(
      "ROBOT_PAYLOAD",
      "로봇 적재 하중",
      plan.robot.maxPayloadKg,
      r.unitLoadKg,
      "kg",
    );
    if (positive(plan.robot.width) && positive(plan.robot.length))
      numberCheck(
        "AISLE_WIDTH",
        "보수적 통행·회전 폭",
        plan.robot.minAisleWidth,
        rounded(Math.hypot(plan.robot.width, plan.robot.length)),
        "m",
      );
    else
      check(
        "ROBOT_FOOTPRINT",
        "실제 로봇 외형",
        "needsReview",
        "실제 로봇 폭·길이를 입력해야 통로와 회전 여유를 확인할 수 있습니다.",
      );
    for (const [key, label] of [
      ["calibration", "도면·축척"],
      ["building", "건물 경계·유효 높이"],
      ["robot", "실제 로봇 사양"],
      ["rack", "랙 치수·하중"],
    ] as const) {
      const ready =
        confirmed(plan[key]) && (key !== "calibration" || !!plan.source);
      check(
        `EVIDENCE_${key.toUpperCase()}`,
        `${label} 근거`,
        ready ? "pass" : "needsReview",
        ready
          ? plan[key].evidence
          : "실측 또는 사양서 근거와 명시적 확인이 필요합니다. 예시 값은 검증 완료로 취급하지 않습니다.",
      );
    }
    const status: PlanningStatus = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "needsReview")
        ? "needsReview"
        : "pass";
    return {
      levels,
      ...geometry,
      requiredClearHeight,
      requiredLiftHeight,
      headroom: finite(plan.building.clearHeight)
        ? rounded(plan.building.clearHeight - geometry.totalHeight)
        : null,
      status,
      checks,
    };
  });
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const intersects = (a: Rect, b: Rect) =>
  a.left < b.right - EPS &&
  a.right > b.left + EPS &&
  a.top < b.bottom - EPS &&
  a.bottom > b.top + EPS;
function obstacleBounds(o: MapObject, clearance: number): Rect {
  const radians = (o.rotation * Math.PI) / 180;
  const width =
    Math.abs(Math.cos(radians)) * o.width +
    Math.abs(Math.sin(radians)) * o.height;
  const depth =
    Math.abs(Math.sin(radians)) * o.width +
    Math.abs(Math.cos(radians)) * o.height;
  return {
    left: o.x - width / 2 - clearance,
    right: o.x + width / 2 + clearance,
    top: o.y - depth / 2 - clearance,
    bottom: o.y + depth / 2 + clearance,
  };
}

/** Deterministic rectangular row search; not a global optimizer or a navigation/safety proof. */
export function generateLayout(
  plan: SpacePlan,
  obstacles: MapObject[],
): LayoutProposal {
  const assumptions = [
    "후보는 직사각형 건물의 로컬 원점 (0,0)을 기준으로 합니다. 도면의 여백·복수 건물과 건물 경계는 별도 확인해야 합니다.",
    "랙 방향 0°/90°와 남는 공간 내 3×3 시작 위치만 비교하는 결정적 휴리스틱입니다. 전역 최적 배치를 보장하지 않습니다.",
    "통로는 실제 로봇 사양의 최소 폭과 차체 대각선 회전 여유를 검사합니다. 실제 회전반경·적재 외형·소방·피난·구조 검토는 별도입니다.",
    "모든 경계에 여유와 횡단 통로를 확보하고 랙 열 사이에 최소 통로 폭을 둡니다. 장애물은 회전 AABB에 통로 폭의 절반을 추가해 제외합니다.",
    "용량은 배치 랙 베이 수 × 단수 × 선반당 단위하중 1개입니다. 개별 슬롯 배치와 실물 인계 가능성은 별도 검증이 필요합니다.",
    "단수와 최대 단수 표시는 지원 범위인 1~100단 안에서 계산합니다.",
    "verified는 입력 근거와 수치 조건의 확인 상태입니다. 통로 연결성·로봇 안전 또는 실설비 설계 승인을 의미하지 않습니다.",
  ];
  const result: LayoutProposal = {
    placements: [],
    orientation: 0,
    capacity5: 0,
    capacity6: 0,
    levels: plan.layout.requestedLevels,
    capacityUnits: 0,
    maxLevelsByHeight: null,
    maxLevelsByLift: null,
    candidateCount: 0,
    issues: [],
    status: "provisional",
    assumptions,
  };
  // Existing placements are outputs to replace, not prerequisites. A smaller revised
  // boundary must be able to regenerate an old out-of-bounds proposal.
  const inputs = { ...plan, layout: { ...plan.layout, placements: [] } };
  const errors = validateSpacePlan(inputs).filter(
    (i) => i.severity === "error",
  );
  if (errors.length) {
    result.issues = errors.map((i) => i.message);
    return result;
  }
  const robot = plan.robot;
  const capacity = verticalCapacity(inputs);
  result.maxLevelsByHeight = capacity.byHeight;
  result.maxLevelsByLift = capacity.byLift;
  if (
    !positive(robot.width) ||
    !positive(robot.length) ||
    !positive(robot.minAisleWidth)
  ) {
    result.issues.push(
      "자동배치 전에 실제 로봇 폭·길이·최소 통로 폭을 입력하세요. 예제 AMR 사양을 대신 사용하지 않습니다.",
    );
    return result;
  }
  const aisle = robot.minAisleWidth;
  if (
    aisle + EPS < robot.width ||
    aisle + EPS < Math.hypot(robot.width, robot.length)
  ) {
    result.issues.push(
      `최소 통로 폭은 차체 폭과 보수적 회전 대각선 ${Math.hypot(robot.width, robot.length).toFixed(3)} m 이상이어야 합니다.`,
    );
    return result;
  }
  if (plan.layout.crossAisle + EPS < aisle) {
    result.issues.push(
      `횡단 통로 폭은 로봇 최소 통로 폭 ${aisle.toFixed(3)} m 이상이어야 합니다.`,
    );
    return result;
  }
  if (
    obstacles.some(
      (o) =>
        ![o.x, o.y, o.width, o.height, o.rotation].every(finite) ||
        o.width <= 0 ||
        o.height <= 0,
    )
  ) {
    result.issues.push(
      "장애물 위치·치수가 유효하지 않아 자동배치를 중단했습니다.",
    );
    return result;
  }
  const inset = plan.layout.margin + plan.layout.crossAisle;
  const usableWidth = plan.building.width - 2 * inset;
  const usableDepth = plan.building.depth - 2 * inset;
  const excluded = obstacles.map((o) => obstacleBounds(o, aisle / 2));
  let best: SpacePlan["layout"]["placements"] = [];
  for (const orientation of [0, 90] as const) {
    const width = orientation === 0 ? plan.rack.width : plan.rack.depth;
    const depth = orientation === 0 ? plan.rack.depth : plan.rack.width;
    const columns = Math.max(0, Math.floor((usableWidth + EPS) / width));
    const rows = Math.max(
      0,
      Math.floor((usableDepth + aisle + EPS) / (depth + aisle)),
    );
    if (!columns || !rows) {
      result.candidateCount++;
      continue;
    }
    if (columns * rows > 20_000) {
      result.issues.push(
        "후보 랙 수가 20,000개를 초과합니다. 건물 또는 랙 치수를 확인하세요.",
      );
      return result;
    }
    const freeX = Math.max(0, usableWidth - columns * width);
    const freeY = Math.max(0, usableDepth - rows * depth - (rows - 1) * aisle);
    for (const xOffset of [0, freeX / 2, freeX])
      for (const yOffset of [0, freeY / 2, freeY]) {
        result.candidateCount++;
        const placements: SpacePlan["layout"]["placements"] = [];
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++) {
            const x = inset + xOffset + column * width + width / 2;
            const y = inset + yOffset + row * (depth + aisle) + depth / 2;
            const bounds = {
              left: x - width / 2,
              right: x + width / 2,
              top: y - depth / 2,
              bottom: y + depth / 2,
            };
            if (excluded.some((o) => intersects(bounds, o))) continue;
            placements.push({
              id: `rack-auto-${String(placements.length + 1).padStart(4, "0")}`,
              x: rounded(x),
              y: rounded(y),
              width: plan.rack.width,
              depth: plan.rack.depth,
              rotation: orientation,
            });
          }
        if (placements.length > best.length) {
          best = placements;
          result.orientation = orientation;
        }
      }
  }
  result.placements = best;
  result.capacity5 = best.length * 5;
  result.capacity6 = best.length * 6;
  result.capacityUnits = best.length * result.levels;
  if (!best.length)
    result.issues.push(
      "경계·통로·장애물 제외 조건을 만족하는 랙 후보가 없습니다.",
    );
  const selected = compareRackLevels(inputs).find(
    (c) => c.levels === plan.layout.requestedLevels,
  )!;
  if (selected.status === "fail")
    result.issues.push(
      `${selected.levels}단 랙의 높이·하중 조건에 불합격 항목이 있습니다. 수평 배치만 임시 제안합니다.`,
    );
  if (selected.status === "needsReview")
    result.issues.push(
      `${selected.levels}단 랙의 인계 범위 또는 검증 근거에 확인 필요 항목이 있습니다.`,
    );
  if (!allConfirmed(plan))
    result.issues.push(
      "도면 축척·건물 경계·실제 로봇·랙 사양의 근거 확인이 모두 끝나지 않아 임시 제안으로 표시합니다.",
    );
  if (
    best.length > 0 &&
    selected.status === "pass" &&
    allConfirmed(plan) &&
    result.issues.length === 0
  )
    result.status = "verified";
  return result;
}
