# CTU Rack Vertical 시뮬레이터

공간 유효 높이, 제품 높이, 로봇(CTU) 전고·작업면 높이를 입력하면 다음을 계산하는 모듈이다.

1. 검토할 랙(단수, 랙 높이)이 설치·운영 가능한지 판정
2. 해당 공간·로봇 조건에서 가능한 최대 단수와 제한 요인
3. 한 단을 더 넣기 위해 필요한 공간 높이·로봇 작업면 높이

`CROIS_AMR_DES_Codex_Requirements.md`의 3번(공간 배치), 6번(로봇 사양), 9번(랙·버퍼) 중 **랙 수직 치수 검토**만 떼어 낸 1차 모듈이다. DES 엔진과 무관한 순수 함수이며 난수를 쓰지 않는다.

- 엔진 이름/버전: `ctu-rack-vertical` / `0.1.0` (`ENGINE_NAME`, `ENGINE_VERSION`)
- 언어: TypeScript (의존성 없음, 개발 의존성만 TypeScript·Vitest·esbuild)

## 설치·실행

```bash
npm install
npm test            # 단위 테스트 20건
npm run build       # dist/index.js (ESM) + dist/ctu-rack-vertical.iife.js (브라우저 전역 CtuRackVertical) + .d.ts
npm run example     # examples/example-input.mm.json 으로 콘솔 출력
```

데모 화면: `npm run build` 후 `demo/index.html`을 브라우저로 연다. 화면은 mm 입력을 m로 바꿔 `simulate()`에 넘기고 결과만 그린다. UI에서 수치를 따로 계산하지 않는다.

## 폴더 구조

```
src/
  types.ts         입력·출력 타입
  units.ts         mm ↔ m 변환, 비교 허용 오차
  validate.ts      입력 검증 (error / warning 구분)
  rackVertical.ts  계산 코어: evaluate, computeMaxLevels, scanLevels, simulate
  defaults.ts      기본 가정값, 예제 입력
  index.ts         공개 API
tests/             Vitest 단위 테스트
examples/          예제 입력(JSON, mm)과 실행 스크립트
demo/              엔진을 호출하는 2D 정면도 데모 화면
```

## 단위

내부 기본 단위는 **m**이다 (요구사항 공통 원칙). 화면·파일에서 mm로 다룰 때는 `mm(값)`으로 m로 바꾸고 `toMm(값)`으로 되돌린다. 예제 JSON은 필드 이름에 `_mm`를 붙여 단위를 명시했다.

## 입력 (`RackVerticalInput`)

| 경로 | 의미 | 예제값 |
|---|---|---|
| `spaceClearHeight` | 바닥 ~ 천장·보·스프링클러 등 가장 낮은 장애물 | 3.000 m |
| `product.height` | 용기 포함 제품 높이 | 0.300 m |
| `robot.overallHeight` | 마스트 최대 상승 시 로봇 전고 (천장 통과 검사) | 3.000 m |
| `robot.workSurfaceMax` | 로봇이 넣고 뺄 수 있는 최고 선반면 | 2.600 m |
| `robot.workSurfaceMin` | 로봇이 넣고 뺄 수 있는 최저 선반면 | 0.100 m |
| `rack.levels` | 검토 단수 (1 이상 정수) | 6 |
| `rack.totalHeight` | 랙 전체 높이. 생략하면 해당 단수의 최소 높이로 계산 | 2.699 m |
| `assumptions.firstShelfHeight` | 바닥 ~ 1단 선반면 | 0.150 m |
| `assumptions.liftClearance` | 제품 상단 ~ 윗단 빔 하단 최소 여유 (포크·트레이 진입) | 0.070 m |
| `assumptions.beamThickness` | 빔(선반) 두께 | 0.050 m |
| `assumptions.ceilingClearance` | 랙 상단 ~ 공간 유효 높이 최소 이격 | 0.300 m |

예제값은 첨부 도면(6단, 약 2,699 mm)에 맞춘 **테스트용 가정**이다. 실측·실사양 근거가 아니므로 실제 랙·로봇 사양서 값으로 바꿔야 한다.

로봇 전고와 최고 작업면은 별도로 받는다. 전고는 천장 통과 여부에만, 작업면은 단별 도달 여부와 최대 단수에 쓴다.

## 계산 모델

```
minPitch     = product.height + liftClearance + beamThickness
pitch        = (totalHeight − firstShelfHeight) / levels
shelf(i)     = firstShelfHeight + (i − 1) · pitch        i = 1..levels
totalHeight  = firstShelfHeight + levels · pitch         (상부 빔 포함)
rackTopLimit = spaceClearHeight − ceilingClearance
```

| 검사 `id` | 통과 조건 | 의미 |
|---|---|---|
| `pitch` | pitch ≥ minPitch | 제품이 단 사이에 들어가고 로봇이 들어올릴 공간이 있다 |
| `ceiling` | totalHeight ≤ rackTopLimit | 천장 이격 확보 |
| `robotReach` | 모든 단에서 workSurfaceMin ≤ shelf(i) ≤ workSurfaceMax | 로봇이 모든 단에 작업 가능 |
| `robotOverall` | overallHeight ≤ spaceClearHeight | 로봇 자체가 공간을 통과 |

`feasible = 네 검사 모두 통과`. 경계값(같음)은 통과로 본다 (허용 오차 0.001 mm).

최대 단수 (최소 피치 기준):

```
bySpace = floor((rackTopLimit − firstShelfHeight) / minPitch)
byRobot = firstShelfHeight가 작업 범위 밖이면 0,
          아니면 floor((workSurfaceMax − firstShelfHeight) / minPitch) + 1
max     = min(bySpace, byRobot)
binding = 'space' | 'robot' | 'both'        더 작은 쪽이 제한 요인
spaceHeightForNext    = firstShelfHeight + (max+1)·minPitch + ceilingClearance
workSurfaceMaxForNext = firstShelfHeight + max·minPitch
```

## API

```ts
import { simulate, evaluate, computeMaxLevels, scanLevels, validateInput, mm, EXAMPLE_INPUT } from 'ctu-rack-vertical';

const rec = simulate({ ...EXAMPLE_INPUT, rack: { levels: 7 } });
rec.issues;               // ValidationIssue[] (error가 있으면 result = null)
rec.result?.feasible;     // false
rec.result?.checks;       // [{ id:'ceiling', pass:false, value, limit, message }, ...]
rec.result?.levelDetails; // 단별 선반면·제품 상단·여유·도달 상태('ok'|'tooHigh'|'tooLow')
rec.result?.maxLevels;    // { bySpace, byRobot, max, binding, spaceHeightForNext, workSurfaceMaxForNext }
rec.scan;                 // 1단 ~ (max+2)단 가능 여부 표
rec.engine;               // { name, version } — 결과 기록용
```

| 함수 | 설명 |
|---|---|
| `validateInput(input)` | 숫자·범위·정수·작업면 순서 검사. `error`/`warning` 구분 |
| `evaluate(input)` | 검증된 입력으로 판정. 검증 없이 호출하면 결과를 보장하지 않음 |
| `computeMaxLevels(input)` | 최대 단수와 제한 요인 |
| `scanLevels(input, upTo?)` | 단수별 최소 높이·가능 여부 |
| `simulate(input, now?)` | 검증 → 평가 → 스캔 + 엔진 버전·입력·실행 시각 기록 |

검증 오류 코드: `NOT_A_NUMBER`, `OUT_OF_RANGE`, `INVALID_LEVELS`, `RACK_BELOW_FIRST_SHELF`, `WORK_RANGE_INVERTED`, `WORK_ABOVE_ROBOT`. 경고 코드: `ZERO_LIFT_CLEARANCE`, `ZERO_CEILING_CLEARANCE`.

## 메인 시뮬레이터에 통합할 때

- **로봇 사양 템플릿(요구사항 6번)**: `RobotVerticalSpec`의 `overallHeight`, `workSurfaceMax`, `workSurfaceMin`을 로봇 템플릿 필드로 추가하고 `robot.id`로 연결한다.
- **랙 객체(요구사항 3·9번)**: 랙의 단 수와 높이가 바뀔 때 `simulate()`를 호출해 배치 검사 결과에 넣는다. `feasible = false`는 오류, `warning`은 검토 필요 사항으로 표시한다. 단별 선반면 높이(`levelDetails[].shelfHeight`)는 랙 슬롯의 높이 속성으로 쓸 수 있다.
- **운송물(요구사항 9번)**: `product.height`는 운송물·용기 종류의 높이에서 가져온다. 여러 품종을 한 랙에 둘 때는 가장 높은 운송물 기준으로 호출한다.
- **저장·재현(요구사항 15번)**: `simulate()`가 돌려주는 `SimulationRecord`(입력, 엔진 버전, 결과)를 그대로 JSON으로 저장하면 같은 결과를 다시 확인할 수 있다. `runAt`만 실행마다 다르다.
- **3D 확장**: 계산 결과는 m 단위 숫자만 담고 화면 좌표를 포함하지 않으므로, 2D 데모의 SVG 대신 3D 렌더러가 같은 결과를 그리면 된다.

## 범위 밖 (후속 검토)

- 랙 깊이·폭, 통로 폭, 로봇 회전 공간 (평면 검사)
- 랙 하중·내진, 슬롯별 허용중량
- 단마다 다른 피치(혼합 품종 랙), 최상단 위 적재
- 스프링클러·조명 등 장애물 위치별 이격 (현재는 단일 `ceilingClearance`)
- 로봇 마스트 상승 시 동적 높이 변화, 바닥 레벨 편차
