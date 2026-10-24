import type { RackAssumptions, RackVerticalInput } from "./types";
import { mm } from "./units";

/**
 * 랙 구조 기본 가정값 — 검토용 예시이며 실측·실사양 근거가 아니다.
 * 실제 프로젝트에서는 랙 제조사·로봇 사양서 값으로 교체한다.
 */
export const DEFAULT_ASSUMPTIONS: RackAssumptions = {
  firstShelfHeight: mm(150),
  liftClearance: mm(70),
  beamThickness: mm(50),
  ceilingClearance: mm(300),
};

/**
 * 예제 입력 — 첨부 도면(6단, 랙 높이 약 2,699 mm)에 맞춘 테스트용 가정.
 */
export const EXAMPLE_INPUT: RackVerticalInput = {
  spaceClearHeight: mm(3000),
  product: { id: "tote-std", height: mm(300) },
  robot: {
    id: "ctu-example",
    overallHeight: mm(3000),
    workSurfaceMax: mm(2600),
    workSurfaceMin: mm(100),
  },
  rack: { levels: 6, totalHeight: mm(2699) },
  assumptions: DEFAULT_ASSUMPTIONS,
};
