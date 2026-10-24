import type { SpacePlan } from "./types";
import { resolveVerticalGeometry } from "./planning";

export interface ElevationRow {
  tier: number;
  rackHeight: number;
  loadTop: number;
  robotShelfHeight: number | null;
  difference: number | null;
  status: "pass" | "fail" | "needsReview";
  reason: string;
}

/** Heights share the same finished-floor datum. Pitch equality is mode dependent. */
export function buildElevationRows(
  plan: SpacePlan,
  levels = plan.layout.requestedLevels,
): ElevationRow[] {
  const { robot, rack } = plan;
  const geometry = resolveVerticalGeometry(plan, levels);
  return Array.from(
    { length: Math.max(1, Math.min(100, Math.floor(levels) || 1)) },
    (_, i) => {
      const rackHeight = rack.firstShelfHeight + i * geometry.pitch;
      const robotShelfHeight =
        robot.firstShelfHeight !== null &&
        robot.shelfPitch !== null &&
        robot.shelfCount !== null &&
        i < robot.shelfCount
          ? robot.firstShelfHeight + i * robot.shelfPitch
          : null;
      const difference =
        robotShelfHeight === null ? null : robotShelfHeight - rackHeight;
      let status: ElevationRow["status"] = "pass";
      let reason = "인계 높이 범위 내";
      if (robot.minTransferHeight === null || robot.maxLiftHeight === null) {
        status = "needsReview";
        reason = "최저·최고 인계 높이 입력 필요";
      } else if (rackHeight < robot.minTransferHeight - 1e-9) {
        status = "fail";
        reason = "최저 인계 가능 높이보다 낮음";
      } else if (rackHeight + rack.liftClearance > robot.maxLiftHeight + 1e-9) {
        status = "fail";
        reason = "인출 여유 포함 최고 인계 높이 초과";
      }
      if (robot.transferMode === "fixedLevels") {
        if (robot.shelfCount !== null && i >= robot.shelfCount) {
          status = "fail";
          reason = "대응하는 로봇 인계 단 부족";
        } else if (robotShelfHeight === null && status !== "fail") {
          status = "needsReview";
          reason = "대응 로봇 단 또는 치수 없음";
        } else if (
          difference !== null &&
          Math.abs(difference) > robot.alignmentTolerance + 1e-9
        ) {
          status = "fail";
          reason = "고정 단 인계 높이 공차 초과";
        } else if (status === "pass") reason = "고정 단 높이 공차 내";
      }
      if (
        plan.building.clearHeight !== null &&
        geometry.totalHeight + rack.topClearance >
          plan.building.clearHeight + 1e-9
      ) {
        status = "fail";
        reason = "상부 빔·이격 포함 랙 전체 높이 초과";
      }
      if (
        robot.overallHeight !== null &&
        plan.building.clearHeight !== null &&
        robot.overallHeight > plan.building.clearHeight + 1e-9
      ) {
        status = "fail";
        reason = "로봇 최대 전고가 유효 천장 초과";
      }
      if (
        status === "pass" &&
        (robot.kind !== "ctu" || robot.overallHeight === null)
      ) {
        status = "needsReview";
        reason = "로봇 전고·외부 인계 설비 확인 필요";
      }
      if (
        status === "pass" &&
        (!robot.confirmed ||
          !rack.confirmed ||
          !plan.building.confirmed ||
          !plan.calibration.confirmed ||
          !plan.source)
      ) {
        status = "needsReview";
        reason = "수치 범위 내 · 입력 근거 확인 필요";
      }
      return {
        tier: i + 1,
        rackHeight,
        loadTop: rackHeight + rack.loadHeight,
        robotShelfHeight,
        difference,
        status,
        reason,
      };
    },
  );
}
