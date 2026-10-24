/**
 * CTU Rack Vertical Simulator — 입력·출력 타입
 *
 * 모든 길이는 내부 기본 단위 m(미터)로 받는다. (요구사항 공통 원칙: m, s, kg, Wh, W)
 * 화면에서 mm로 입력받는 경우 `units.ts`의 `mm()` / `toMm()`로 변환한다.
 */

/** 로봇(CTU·ACR 등) 수직 사양 */
export interface RobotVerticalSpec {
  /** 로봇 사양 템플릿 ID (요구사항 6번 로봇 사양과 연결) */
  id?: string;
  /** 마스트 최대 상승 시 로봇 전고 [m] — 천장 통과 검사에 사용 */
  overallHeight: number;
  /** 로봇이 제품을 넣고 뺄 수 있는 최고 선반면 높이 [m] */
  workSurfaceMax: number;
  /** 로봇이 제품을 넣고 뺄 수 있는 최저 선반면 높이 [m] */
  workSurfaceMin: number;
}

/** 운송물(토트·박스, 용기 포함) */
export interface ProductSpec {
  id?: string;
  /** 용기 포함 제품 높이 [m] */
  height: number;
}

/** 검토 대상 랙 */
export interface RackPlan {
  /** 단수 (1~100 정수: 유한한 UI·스캔 범위) */
  levels: number;
  /**
   * 랙 전체 높이 [m] (바닥 ~ 상부 빔 상단).
   * 생략하면 해당 단수의 최소 랙 높이로 계산한다.
   */
  totalHeight?: number;
}

/** 랙 구조 가정값. 기본값은 검토용 예시이며 실제 사양으로 교체해야 한다. */
export interface RackAssumptions {
  /** 바닥 ~ 1단 선반면 [m] */
  firstShelfHeight: number;
  /** 제품 상단 ~ 윗단 빔 하단 최소 여유 (포크·트레이 진입) [m] */
  liftClearance: number;
  /** 빔(선반) 두께 [m] */
  beamThickness: number;
  /** 랙 상단 ~ 공간 유효 높이 최소 이격 [m] */
  ceilingClearance: number;
}

export interface RackVerticalInput {
  /** 바닥 ~ 천장·보·스프링클러 등 가장 낮은 장애물 [m] */
  spaceClearHeight: number;
  product: ProductSpec;
  robot: RobotVerticalSpec;
  rack: RackPlan;
  assumptions: RackAssumptions;
}

export type CheckId = "pitch" | "ceiling" | "robotReach" | "robotOverall";

export interface CheckResult {
  id: CheckId;
  pass: boolean;
  /** 비교 대상 실제값 [m] */
  value: number;
  /** 한계값 [m] */
  limit: number;
  /** 사람이 읽는 설명 (한국어) */
  message: string;
}

export type ReachStatus = "ok" | "tooHigh" | "tooLow";

export interface LevelResult {
  /** 1부터 시작하는 단 번호 (아래에서 위로) */
  index: number;
  /** 선반면 높이 [m] */
  shelfHeight: number;
  /** 제품 상단 높이 [m] */
  productTop: number;
  /** 제품 상단 ~ 윗단 빔 하단 실제 여유 [m] */
  clearanceAbove: number;
  reach: ReachStatus;
}

export type BindingConstraint = "space" | "robot" | "both";

export interface MaxLevelsResult {
  /** 공간 높이만 고려한 최대 단수 */
  bySpace: number;
  /** 로봇 작업 범위와 로봇 전고의 공간 통과 조건을 고려한 최대 단수. 전고 초과 시 0. */
  byRobot: number;
  /** 최종 최대 단수 = min(bySpace, byRobot) */
  max: number;
  binding: BindingConstraint;
  /** max+1 단을 넣기 위해 필요한 공간 유효 높이 [m] */
  spaceHeightForNext: number;
  /** max+1 단을 넣기 위해 필요한 로봇 최고 작업면 [m] */
  workSurfaceMaxForNext: number;
}

export interface RackVerticalResult {
  feasible: boolean;
  levels: number;
  /** 랙 전체 높이 [m] */
  totalHeight: number;
  /** totalHeight를 입력하지 않아 최소 높이로 계산했는지 */
  totalHeightIsMinimum: boolean;
  /** 실제 단 피치 [m] */
  pitch: number;
  /** 최소 단 피치 = 제품 + 들어올림 여유 + 빔 [m] */
  minPitch: number;
  /** 랙 상단 허용 한계 = 공간 − 천장 이격 [m] */
  rackTopLimit: number;
  /** 천장까지 남는 높이 [m] */
  headroom: number;
  checks: CheckResult[];
  levelDetails: LevelResult[];
  maxLevels: MaxLevelsResult;
}

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  /** 입력 경로 (예: "robot.workSurfaceMax") */
  field: string;
  message: string;
}

/** 단수별 스캔 결과 한 행 */
export interface LevelScanRow {
  levels: number;
  minTotalHeight: number;
  ceilingPass: boolean;
  robotPass: boolean;
  feasible: boolean;
}
