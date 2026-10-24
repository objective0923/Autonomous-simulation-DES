import { useMemo, useRef, useState, type ChangeEvent } from "react";
import type { Project, SpacePlan } from "./types";
import {
  compareRackLevels,
  createSpacePlan,
  generateLayout,
  verticalCapacity,
} from "./planning";
import UiSource from "./UiSource";
import UiScene3D from "./UiScene3D";
import UiElevation from "./UiElevation";
import {
  EXAMPLE_INPUT,
  parseMillimeterInput,
  type RackVerticalInput,
} from "./vertical";
import "./UiPlanning.css";

interface Props {
  project: Project;
  onChange: (project: Project) => void;
  disabled?: boolean;
  onComplete?: () => void;
}
type PlanStep = 0 | 1 | 2 | 3 | 4 | 5;
type Proposal = ReturnType<typeof generateLayout>;
const fmt = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "미입력"
    : value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
const statusText = {
  pass: "입력 기준 충족",
  fail: "조건 미충족",
  needsReview: "추가 확인 필요",
} as const;

function NumberField({
  label,
  unit = "m",
  value,
  onChange,
  disabled = false,
  detail,
  nullable = false,
  step = 0.1,
}: {
  label: string;
  unit?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  detail?: string;
  nullable?: boolean;
  step?: number;
}) {
  return (
    <label className="plan-field">
      <span>
        {label}
        <small>{unit}</small>
      </span>
      <input
        type="number"
        min={0}
        step={step}
        value={value ?? ""}
        placeholder={nullable ? "사양 확인 후 입력" : ""}
        disabled={disabled}
        onChange={(event) => {
          const input = event.currentTarget;
          if (input.value === "") onChange(nullable ? null : 0);
          else if (Number.isFinite(input.valueAsNumber))
            onChange(input.valueAsNumber);
        }}
      />
      {detail && <em>{detail}</em>}
    </label>
  );
}

function Evidence({
  title,
  confirmed,
  evidence,
  onEvidence,
  onConfirm,
  complete,
  disabled,
}: {
  title: string;
  confirmed: boolean;
  evidence: string;
  onEvidence: (value: string) => void;
  onConfirm: (value: boolean) => void;
  complete: boolean;
  disabled: boolean;
}) {
  return (
    <div className="plan-evidence">
      <label className="plan-field">
        <span>확인 근거</span>
        <input
          value={evidence}
          placeholder="예: 도면 번호·측정일·제조사 사양서 버전"
          disabled={disabled}
          onChange={(event) => onEvidence(event.target.value)}
        />
      </label>
      <label className="plan-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || !complete || !evidence.trim()}
          onChange={(event) => onConfirm(event.target.checked)}
        />
        <span>
          {title}을 근거 자료와 대조했습니다.
          <small>
            {!complete
              ? "필수 수치를 입력하면 확인할 수 있습니다."
              : !evidence.trim()
                ? "확인 근거를 입력하세요."
                : "사용자가 확인한 입력이며 설계 승인을 의미하지 않습니다."}
          </small>
        </span>
      </label>
    </div>
  );
}

export default function UiPlanning({
  project,
  onChange,
  disabled = false,
  onComplete,
}: Props) {
  const [step, setStep] = useState<PlanStep>(0);
  const [candidateA, setCandidateA] = useState(5);
  const [candidateB, setCandidateB] = useState(6);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [message, setMessage] = useState("");
  const verticalFileRef = useRef<HTMLInputElement>(null);
  const plan = useMemo(
    () => project.spacePlan ?? createSpacePlan(),
    [project.spacePlan],
  );
  const comparisons = useMemo(
    () => compareRackLevels(plan, [candidateA, candidateB]),
    [plan, candidateA, candidateB],
  );
  const activeComparison = useMemo(
    () => compareRackLevels(plan, [plan.layout.requestedLevels])[0],
    [plan],
  );
  const vertical = useMemo(() => verticalCapacity(plan), [plan]);
  const canConfirmBuilding =
    plan.building.width > 0 &&
    plan.building.depth > 0 &&
    (plan.building.clearHeight ?? 0) > 0;
  const canConfirmRobot =
    [
      plan.robot.width,
      plan.robot.length,
      plan.robot.minAisleWidth,
      plan.robot.maxPayloadKg,
      plan.robot.overallHeight,
    ].every((v) => v !== null && v > 0) &&
    (plan.robot.kind !== "ctu" ||
      (plan.robot.minTransferHeight !== null &&
        plan.robot.minTransferHeight >= 0 &&
        plan.robot.maxLiftHeight !== null &&
        plan.robot.maxLiftHeight >= plan.robot.minTransferHeight)) &&
    (plan.robot.transferMode !== "fixedLevels" ||
      (plan.robot.firstShelfHeight !== null &&
        plan.robot.firstShelfHeight >= 0 &&
        plan.robot.shelfPitch !== null &&
        plan.robot.shelfPitch > 0 &&
        plan.robot.shelfCount !== null &&
        Number.isInteger(plan.robot.shelfCount) &&
        plan.robot.shelfCount > 0));
  const canConfirmRack =
    plan.rack.width > 0 &&
    plan.rack.depth > 0 &&
    plan.rack.shelfPitch > 0 &&
    plan.rack.shelfCapacityKg > 0 &&
    plan.rack.unitLoadKg > 0 &&
    plan.rack.loadHeight > 0 &&
    (plan.rack.heightMode !== "totalHeight" ||
      (plan.rack.totalHeight !== null &&
        plan.rack.totalHeight > plan.rack.firstShelfHeight));
  const placements = plan.layout.placements;
  const hasEvidence =
    plan.calibration.confirmed &&
    plan.building.confirmed &&
    plan.robot.confirmed &&
    plan.rack.confirmed;

  const updatePlan = (edit: (next: SpacePlan) => void, invalidate = true) => {
    if (disabled) return;
    const next = structuredClone(project);
    next.spacePlan = structuredClone(plan);
    edit(next.spacePlan);
    if (invalidate) {
      next.spacePlan.layout.placements = [];
      setProposal(null);
    }
    setMessage("");
    onChange(next);
  };
  const updateNumber = (
    section: "building" | "robot" | "rack",
    key: string,
    value: number | null,
  ) =>
    updatePlan((next) => {
      (next[section] as unknown as Record<string, unknown>)[key] = value;
      next[section].confirmed = false;
    });
  const sourceChange = (next: Project) => {
    if (disabled) return;
    if (next.spacePlan) next.spacePlan.layout.placements = [];
    setProposal(null);
    setMessage("");
    onChange(next);
  };
  const generate = () => {
    if (disabled) return;
    try {
      const obstacles = project.objects.filter(
        (object) => !object.id.startsWith("plan-rack-"),
      );
      const generated = generateLayout(plan, obstacles);
      updatePlan((next) => {
        next.layout.placements = structuredClone(generated.placements);
      }, false);
      setProposal(generated);
      setMessage(
        generated.placements.length
          ? `랙 ${generated.placements.length}개 후보를 저장했습니다. 조건 검토 후 2D 배치에 적용할 수 있습니다.`
          : "배치 가능한 후보가 없습니다. 누락 사양·공간·장애물 조건을 확인하세요.",
      );
    } catch (error) {
      setMessage(`후보 생성 실패: ${String(error)}`);
    }
  };
  const applyLayout = () => {
    if (disabled || !placements.length) return;
    if (activeComparison?.status === "fail") {
      setMessage(
        "선택 단수의 높이·하중 조건이 불합격입니다. 조건을 수정한 뒤 2D 배치에 적용하세요.",
      );
      return;
    }
    const next = structuredClone(project);
    next.objects = [
      ...next.objects.filter((object) => !object.id.startsWith("plan-rack-")),
      ...placements.map((rack, index) => ({
        id: `plan-rack-${index + 1}`,
        name: `계획 랙 ${index + 1} · ${plan.layout.requestedLevels}단`,
        kind: "rack" as const,
        x: rack.x,
        y: rack.y,
        width: rack.width,
        height: rack.depth,
        rotation: rack.rotation,
      })),
    ];
    onChange(next);
    setMessage(
      `계획 랙 ${placements.length}개를 2D 장식 객체에 반영했습니다. AMR 접근 노드·경로·재고 슬롯은 별도로 연결하세요.`,
    );
  };
  const applyVertical = (input: RackVerticalInput, label: string) => {
    updatePlan((next) => {
      next.building.clearHeight = input.spaceClearHeight;
      next.building.confirmed = false;
      next.building.evidence = label;
      next.calibration.confirmed = false;
      next.calibration.evidence = label;
      next.robot = {
        ...next.robot,
        kind: "ctu",
        overallHeight: input.robot.overallHeight,
        minTransferHeight: input.robot.workSurfaceMin,
        maxLiftHeight: input.robot.workSurfaceMax,
        transferMode: "liftRange",
        confirmed: false,
        evidence: label,
      };
      next.rack = {
        ...next.rack,
        heightMode:
          input.rack.totalHeight === undefined ? "minimum" : "totalHeight",
        totalHeight: input.rack.totalHeight ?? null,
        firstShelfHeight: input.assumptions.firstShelfHeight,
        loadHeight: input.product.height,
        liftClearance: input.assumptions.liftClearance,
        beamThickness: input.assumptions.beamThickness,
        topClearance: input.assumptions.ceilingClearance,
        confirmed: false,
        evidence: label,
      };
      next.layout.requestedLevels = input.rack.levels;
    });
    setCandidateA(5);
    setCandidateB(input.rack.levels === 5 ? 6 : input.rack.levels);
    setStep(4);
    setMessage(
      `${label}을 입력했습니다. 실제 도면·로봇 외형·통로·하중 사양은 별도로 확인하세요. 확인 상태는 모두 해제됩니다.`,
    );
  };
  const importVertical = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || disabled) return;
    try {
      if (file.size > 1024 * 1024)
        throw new Error("버티컬 사양 JSON은 1 MB 이하로 준비해 주세요.");
      applyVertical(
        parseMillimeterInput(JSON.parse(await file.text())),
        `가져온 수직 사양: ${file.name} · 실사양 근거 미확인`,
      );
    } catch (error) {
      setMessage(
        `버티컬 사양 불러오기 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    event.target.value = "";
  };
  const demoRobot = () =>
    updatePlan((next) => {
      next.robot = {
        kind: "ctu",
        width: 1,
        length: 1.5,
        minAisleWidth: 2.8,
        minTransferHeight: 0.2,
        maxLiftHeight: 6,
        overallHeight: 6.5,
        firstShelfHeight: 0.4,
        shelfPitch: 0.6,
        shelfCount: 8,
        transferMode: "liftRange",
        alignmentTolerance: 0.02,
        maxPayloadKg: 500,
        confirmed: false,
        evidence: "DEMO 가정값: 실제 로봇 사양서 확인 전, 치수·성능 보증 없음",
      };
    });

  const steps = [
    {
      label: "도면",
      title: "도면을 준비해 주세요",
      help: "고객 도면을 넣거나, 도면 없이 기본 예제로 시작할 수 있습니다.",
    },
    {
      label: "공간",
      title: "공간 크기를 알려주세요",
      help: "사용할 공간의 가로·세로·높이만 먼저 입력하세요. 모르는 값은 나중에 입력해도 됩니다.",
    },
    {
      label: "로봇",
      title: "사용할 로봇을 알려주세요",
      help: "정해진 로봇 사양만 입력하세요. 실제 사양이 없으면 비워 두고 진행할 수 있습니다.",
    },
    {
      label: "랙",
      title: "랙과 운송물을 입력해 주세요",
      help: "단수와 운송물 높이를 입력하고, 선반 간격 또는 랙 전체 높이를 선택하세요.",
    },
    {
      label: "높이 검토",
      title: "높이가 맞는지 확인해 보세요",
      help: "선택한 단수의 랙·로봇 높이를 같은 바닥 기준으로 비교합니다.",
    },
    {
      label: "배치",
      title: "배치를 확인하고 실행하세요",
      help: "로봇 외형과 통로 폭이 준비되면 배치 후보를 만들 수 있습니다. 배치는 나중에 해도 됩니다.",
    },
  ];
  const field = (
    section: "building" | "robot" | "rack",
    key: string,
    label: string,
    options: {
      nullable?: boolean;
      unit?: string;
      step?: number;
      detail?: string;
      disabled?: boolean;
    } = {},
  ) => (
    <NumberField
      label={label}
      value={(plan[section] as unknown as Record<string, number | null>)[key]}
      onChange={(value) =>
        updateNumber(section, key, options.nullable ? value : (value ?? 0))
      }
      {...options}
      disabled={disabled || options.disabled}
    />
  );
  const confirmation = (
    section: "building" | "robot" | "rack",
    title: string,
    complete: boolean,
  ) => (
    <details className="plan-extra plan-confirmation">
      <summary>
        치수 확인 · {title}
        <span>{plan[section].confirmed ? "확인됨" : "나중에 확인 가능"}</span>
      </summary>
      <Evidence
        title={title}
        confirmed={plan[section].confirmed}
        evidence={plan[section].evidence}
        complete={complete}
        disabled={disabled}
        onEvidence={(value) =>
          updatePlan((next) => {
            next[section].evidence = value;
            next[section].confirmed = false;
          })
        }
        onConfirm={(value) =>
          updatePlan((next) => {
            next[section].confirmed = value;
          })
        }
      />
    </details>
  );
  const levelsField = (label: string) => (
    <NumberField
      label={label}
      unit="단"
      value={plan.layout.requestedLevels}
      step={1}
      disabled={disabled}
      onChange={(value) =>
        updatePlan((next) => {
          next.layout.requestedLevels = Math.max(
            1,
            Math.min(100, Math.floor(value ?? 1)),
          );
        })
      }
    />
  );
  const checkList = (comparison: NonNullable<typeof activeComparison>) => (
    <ul className="plan-check-list">
      {comparison.checks.map((check) => (
        <li key={check.code} className={check.status}>
          <i>
            {check.status === "pass"
              ? "✓"
              : check.status === "fail"
                ? "×"
                : "!"}
          </i>
          <div>
            <strong>{check.label}</strong>
            <p>{check.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <section
      className="planning-workspace"
      aria-label="공간 및 랙 사전 설계"
      data-testid="scenario-wizard"
      data-step={step}
    >
      <nav className="plan-pipeline" aria-label="시나리오 입력 단계">
        {steps.map((item, index) => (
          <button
            key={item.label}
            aria-label={`단계 ${index + 1}: ${item.label}`}
            aria-current={step === index ? "step" : undefined}
            className={
              step === index ? "active" : step > index ? "visited" : ""
            }
            onClick={() => setStep(index as PlanStep)}
          >
            <b>{index + 1}</b>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="plan-wizard-heading">
        <div>
          <span className="plan-step-caption">
            STEP {step + 1} / {steps.length}
          </span>
          <h2>{steps[step].title}</h2>
          <p>{steps[step].help}</p>
        </div>
        <span className="plan-draft-badge">
          {hasEvidence ? "입력 근거 확인됨" : "작성 중 · 미확인 값 포함"}
        </span>
      </div>
      {disabled && (
        <p className="plan-notice">
          실행 기록을 보는 동안에는 입력이 잠깁니다. 초기화 후 수정할 수
          있습니다.
        </p>
      )}

      {step === 0 && (
        <div className="plan-step-body">
          <UiSource
            project={project}
            onChange={sourceChange}
            disabled={disabled}
          />
          <p className="plan-subtle">
            도면이 없어도 예제 운영 조건으로 시뮬레이션을 시작할 수 있습니다.
            실제 배치 검토 전에는 도면과 치수를 확인하세요.
          </p>
        </div>
      )}

      {step === 1 && (
        <section
          className="plan-card plan-focused-card"
          aria-label="공간 기본 입력"
        >
          <div className="plan-card-body">
            <div className="plan-form-section">
              <h3>사용할 공간</h3>
              <p>길이는 m로 입력합니다. 10,000 mm는 10 m입니다.</p>
            </div>
            <div className="plan-three-fields">
              {field("building", "width", "건물 유효 가로")}
              {field("building", "depth", "건물 유효 세로")}
              {field("building", "clearHeight", "유효 천장 높이", {
                nullable: true,
                detail: "보·배관 등 가장 낮은 장애물 아래 높이",
              })}
            </div>
            <p className="plan-assumption">
              초기 평면 {fmt(createSpacePlan().building.width)} ×{" "}
              {fmt(createSpacePlan().building.depth)} m는 예제 가정입니다. 실제
              도면의 치수로 바꿔 주세요.
            </p>
            {confirmation("building", "공간 치수", canConfirmBuilding)}
          </div>
        </section>
      )}

      {step === 2 && (
        <section
          className="plan-card plan-focused-card"
          aria-label="로봇 기본 입력"
        >
          <div className="plan-card-body">
            <label className="plan-field">
              <span>장비 방식</span>
              <select
                aria-label="장비 방식"
                value={plan.robot.kind}
                disabled={disabled}
                onChange={(event) =>
                  updatePlan((next) => {
                    next.robot.kind = event.target
                      .value as SpacePlan["robot"]["kind"];
                    next.robot.confirmed = false;
                  })
                }
              >
                <option value="ctu">CTU · 선반 인계형</option>
                <option value="lowProfile">저상형 AMR</option>
                <option value="pallet">팔레트 AMR</option>
              </select>
            </label>
            <div className="plan-form-section">
              <h3>바닥면과 통로</h3>
              <p>아직 정해지지 않은 로봇 사양은 비워 두세요.</p>
            </div>
            <div className="plan-three-fields">
              {field("robot", "width", "로봇 외형 폭", { nullable: true })}
              {field("robot", "length", "로봇 외형 길이", { nullable: true })}
              {field("robot", "minAisleWidth", "최소 작업 통로 폭", {
                nullable: true,
              })}
            </div>
            <div className="plan-form-section">
              <h3>인계 가능한 높이</h3>
              <p>
                {plan.robot.kind === "ctu"
                  ? "제품을 넣고 뺄 수 있는 높이와 로봇 전체 높이를 구분합니다."
                  : "고단 랙 인계는 별도 승강·인계 설비가 필요할 수 있습니다."}
              </p>
            </div>
            <div className="plan-three-fields">
              {field("robot", "minTransferHeight", "최저 인계 가능 높이", {
                nullable: true,
              })}
              {field("robot", "maxLiftHeight", "최고 인계 가능 높이", {
                nullable: true,
              })}
              {field("robot", "overallHeight", "마스트 최대 상승 전고", {
                nullable: true,
              })}
            </div>
            <details className="plan-extra">
              <summary>고급 설정 · 내부 선반과 하중</summary>
              <p className="plan-subtle">
                내부 선반 피치와 랙 피치는 서로 다른 사양입니다. 연속 승강형은
                피치가 달라도 작업 범위로 판단합니다.
              </p>
              <label className="plan-field">
                <span>인계 방식</span>
                <select
                  aria-label="인계 방식"
                  value={plan.robot.transferMode}
                  disabled={disabled}
                  onChange={(event) =>
                    updatePlan((next) => {
                      next.robot.transferMode = event.target
                        .value as SpacePlan["robot"]["transferMode"];
                      next.robot.confirmed = false;
                    })
                  }
                >
                  <option value="liftRange">연속 승강 범위에서 인계</option>
                  <option value="fixedLevels">고정된 선반 높이에서 인계</option>
                </select>
              </label>
              <div className="plan-two-fields">
                {field("robot", "firstShelfHeight", "장비 첫 선반 높이", {
                  nullable: true,
                })}
                {field("robot", "shelfPitch", "장비 선반 피치", {
                  nullable: true,
                })}
                {field("robot", "shelfCount", "장비 내부 선반 수", {
                  nullable: true,
                  unit: "단",
                  step: 1,
                })}
                {field("robot", "alignmentTolerance", "고정 인계 높이 오차", {
                  step: 0.001,
                })}
                {field("robot", "maxPayloadKg", "최대 적재 중량", {
                  nullable: true,
                  unit: "kg",
                  step: 10,
                })}
              </div>
              <button
                className="button small"
                disabled={disabled}
                onClick={demoRobot}
              >
                DEMO 로봇 가정값 입력
              </button>
              <p className="plan-subtle">
                예제를 넣어도 실제 로봇 사양 확인으로 표시하지 않습니다.
              </p>
            </details>
            {confirmation("robot", "로봇 사양", canConfirmRobot)}
          </div>
        </section>
      )}

      {step === 3 && (
        <section
          className="plan-card plan-focused-card"
          aria-label="랙 기본 입력"
        >
          <div className="plan-card-body">
            <div className="plan-form-section">
              <h3>검토할 랙</h3>
              <p>단수와 제품 높이부터 정하면 높이 검토를 시작할 수 있습니다.</p>
            </div>
            <div className="plan-three-fields">
              {levelsField("검토할 랙 단수")}
              {field("rack", "loadHeight", "운송물 높이")}
              {field("rack", "firstShelfHeight", "첫 선반 높이")}
            </div>
            <label className="plan-field">
              <span>랙 높이 산정 방식</span>
              <select
                aria-label="랙 높이 산정 방식"
                value={plan.rack.heightMode}
                disabled={disabled}
                onChange={(event) =>
                  updatePlan((next) => {
                    next.rack.heightMode = event.target
                      .value as SpacePlan["rack"]["heightMode"];
                    next.rack.confirmed = false;
                  })
                }
              >
                <option value="pitch">선반 피치 지정</option>
                <option value="totalHeight">
                  구조 총높이 지정 · 피치 역산
                </option>
                <option value="minimum">운송물에 맞는 최소 높이</option>
              </select>
            </label>
            {plan.rack.heightMode === "pitch" &&
              field("rack", "shelfPitch", "선반 간 피치", {
                detail: "아래 선반면부터 다음 선반면까지의 높이 차이",
              })}
            {plan.rack.heightMode === "totalHeight" &&
              field("rack", "totalHeight", "랙 구조 총높이", {
                nullable: true,
                detail: "바닥부터 상부 빔 상단까지의 높이",
              })}
            <p className="plan-assumption">
              기본 선반·여유 수치는 예제 가정입니다. 상세 조건은 필요할 때 펼쳐
              수정하세요.
            </p>
            <details className="plan-extra">
              <summary>고급 설정 · 랙 크기·여유·하중</summary>
              <div className="plan-two-fields">
                {field("rack", "width", "랙 모듈 가로")}
                {field("rack", "depth", "랙 모듈 깊이")}
                {plan.rack.heightMode !== "pitch" &&
                  field("rack", "shelfPitch", "지정 피치 (현재 모드 미사용)", {
                    disabled: true,
                  })}
                {field("rack", "topClearance", "상부 여유 높이")}
                {field("rack", "liftClearance", "인계 상승 여유")}
                {field("rack", "beamThickness", "선반 빔 두께", { step: 0.01 })}
                {field("rack", "unitLoadKg", "운송물 중량", {
                  unit: "kg",
                  step: 10,
                })}
                {field("rack", "shelfCapacityKg", "선반 허용 중량", {
                  unit: "kg",
                  step: 10,
                })}
              </div>
            </details>
            {confirmation("rack", "랙 사양", canConfirmRack)}
          </div>
        </section>
      )}

      {step === 4 && (
        <div className="plan-step-body">
          <section
            className={`plan-review-summary ${activeComparison?.status ?? "needsReview"}`}
          >
            <div>
              <span className="plan-status">
                {activeComparison
                  ? statusText[activeComparison.status]
                  : "추가 확인 필요"}
              </span>
              <h3>{plan.layout.requestedLevels}단 검토 결과</h3>
              <p>
                {activeComparison?.status === "fail"
                  ? "현재 조건에 맞지 않는 항목이 있습니다. 상세 사유를 확인하고 앞 단계에서 수정하세요."
                  : activeComparison?.status === "pass"
                    ? "입력한 치수와 확인 근거 기준을 충족합니다."
                    : "비어 있거나 확인되지 않은 사양이 있습니다. 작성 중인 시나리오로 계속 보관할 수 있습니다."}
              </p>
            </div>
            {levelsField("측면도 기준 단수")}
          </section>
          <div className="plan-review-metrics">
            <div>
              <span>랙 구조 총높이</span>
              <strong>
                {fmt(activeComparison?.totalHeight)} <small>m</small>
              </strong>
            </div>
            <div>
              <span>필요 유효 천장</span>
              <strong>
                {fmt(activeComparison?.requiredClearHeight)} <small>m</small>
              </strong>
            </div>
            <div>
              <span>필요 인계 높이</span>
              <strong>
                {fmt(activeComparison?.requiredLiftHeight)} <small>m</small>
              </strong>
            </div>
            <div>
              <span>높이 기준 최대 단수</span>
              <strong>
                {fmt(vertical.max, 0)} <small>단</small>
              </strong>
            </div>
          </div>
          <details className="plan-extra">
            <summary>
              검토 사유 자세히 보기
              <span>
                {activeComparison?.checks.filter(
                  (check) => check.status !== "pass",
                ).length ?? 0}
                개 확인 항목
              </span>
            </summary>
            {activeComparison && checkList(activeComparison)}
          </details>
          <UiElevation plan={plan} levels={plan.layout.requestedLevels} />
          <details className="plan-extra plan-alternatives">
            <summary>다른 단수와 비교</summary>
            <div className="plan-two-fields">
              <NumberField
                label="대안 A 단수"
                unit="단"
                value={candidateA}
                step={1}
                onChange={(value) =>
                  setCandidateA(
                    Math.max(1, Math.min(100, Math.floor(value ?? 5))),
                  )
                }
              />
              <NumberField
                label="대안 B 단수"
                unit="단"
                value={candidateB}
                step={1}
                onChange={(value) =>
                  setCandidateB(
                    Math.max(1, Math.min(100, Math.floor(value ?? 6))),
                  )
                }
              />
            </div>
            <div className="plan-comparison-grid">
              {comparisons.map((comparison) => (
                <section
                  className={`plan-level-card ${comparison.status}`}
                  key={comparison.levels}
                >
                  <header>
                    <h3>{comparison.levels}단</h3>
                    <span className={`plan-status ${comparison.status}`}>
                      {statusText[comparison.status]}
                    </span>
                  </header>
                  <div className="plan-level-metrics">
                    <div>
                      <span>구조 총높이</span>
                      <strong>{fmt(comparison.totalHeight)} m</strong>
                    </div>
                    <div>
                      <span>필요 천장</span>
                      <strong>{fmt(comparison.requiredClearHeight)} m</strong>
                    </div>
                    <div>
                      <span>산정 피치</span>
                      <strong>{fmt(comparison.pitch)} m</strong>
                    </div>
                  </div>
                  <details className="plan-extra">
                    <summary>검토 사유</summary>
                    {checkList(comparison)}
                    <p className="plan-subtle">
                      최소 피치 {fmt(comparison.minPitch)} m · 운송물 위 여유{" "}
                      {fmt(comparison.clearanceAbove)} m · 천장 잔여{" "}
                      {fmt(comparison.headroom)} m
                    </p>
                  </details>
                  <footer>
                    <button
                      className="button small"
                      disabled={disabled}
                      onClick={() =>
                        updatePlan((next) => {
                          next.layout.requestedLevels = comparison.levels;
                        })
                      }
                    >
                      {comparison.levels}단 배치로 선택
                    </button>
                  </footer>
                </section>
              ))}
            </div>
            <p className="plan-subtle">
              최대 단수는 높이 기준 상한입니다. 다음 단에 필요한 천장{" "}
              {fmt(vertical.spaceHeightForNext)} m · 작업면{" "}
              {fmt(vertical.workSurfaceMaxForNext)} m. 구조·소방·현장 인계
              조건은 별도 확인이 필요합니다.
            </p>
          </details>
        </div>
      )}

      {step === 5 && (
        <div className="plan-step-body">
          <div className="plan-layout-grid">
            <aside className="plan-card plan-layout-controls">
              <div className="plan-card-body">
                <h3>배치 후보</h3>
                <p className="plan-subtle">
                  실제 로봇 외형과 통로 조건이 있을 때 생성합니다. 아직 사양이
                  없으면 이 단계는 건너뛰세요.
                </p>
                <div
                  className={`plan-inline-check ${activeComparison?.status ?? "needsReview"}`}
                >
                  <strong>
                    {plan.layout.requestedLevels}단 높이·하중 조건
                  </strong>
                  <span>
                    {activeComparison
                      ? statusText[activeComparison.status]
                      : "추가 확인 필요"}
                  </span>
                </div>
                <div className="plan-layout-reference">
                  <span>최소 작업 통로</span>
                  <strong>{fmt(plan.robot.minAisleWidth)} m</strong>
                </div>
                <details className="plan-extra">
                  <summary>배치 여유 조정</summary>
                  <NumberField
                    label="외곽 여유 거리"
                    value={plan.layout.margin}
                    onChange={(value) =>
                      updatePlan((next) => {
                        next.layout.margin = value ?? 0;
                      })
                    }
                    disabled={disabled}
                  />
                  <NumberField
                    label="횡단 통로 폭"
                    value={plan.layout.crossAisle}
                    onChange={(value) =>
                      updatePlan((next) => {
                        next.layout.crossAisle = value ?? 0;
                      })
                    }
                    disabled={disabled}
                  />
                </details>
                <button
                  className="button primary full"
                  onClick={generate}
                  disabled={disabled}
                >
                  배치 후보 생성
                </button>
                <div className="plan-layout-stat">
                  <span>랙 후보</span>
                  <strong>
                    {placements.length}
                    <small>개</small>
                  </strong>
                </div>
                <div className="plan-layout-stat">
                  <span>{plan.layout.requestedLevels}단 기하 용량</span>
                  <strong>
                    {fmt(
                      proposal?.capacityUnits ??
                        placements.length * plan.layout.requestedLevels,
                      0,
                    )}
                    <small>위치</small>
                  </strong>
                </div>
                <button
                  className="button full"
                  disabled={
                    disabled ||
                    !placements.length ||
                    activeComparison?.status === "fail"
                  }
                  onClick={applyLayout}
                >
                  후보를 2D 객체로 적용
                </button>
                <p className="plan-subtle">
                  높이·하중 불합격 후보는 적용할 수 없습니다. 위치 수는 선반당
                  운송물 1개 가정입니다.
                </p>
              </div>
            </aside>
            <section className="plan-scene-card">
              <div className="plan-scene-heading">
                <div>
                  <h3>3D 배치 · 높이 검토</h3>
                  <p>
                    {fmt(plan.building.width)} × {fmt(plan.building.depth)} m ·{" "}
                    {plan.layout.requestedLevels}단
                  </p>
                </div>
                <span
                  className={`plan-status ${proposal?.status === "verified" ? "pass" : "needsReview"}`}
                >
                  {proposal?.status === "verified"
                    ? "입력 확인 기반 후보"
                    : "가정 포함 · 잠정 후보"}
                </span>
              </div>
              <UiScene3D project={project} plan={plan} />
            </section>
          </div>
          {proposal && (
            <details
              className="plan-extra plan-proposal-report"
              open={proposal.issues.length > 0}
            >
              <summary>
                후보 생성 근거<span>{proposal.candidateCount}개 조건 비교</span>
              </summary>
              {proposal.issues.length > 0 && (
                <ul>
                  {proposal.issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
              <p className="plan-subtle">{proposal.assumptions.join(" · ")}</p>
            </details>
          )}
          <p className="plan-subtle">
            2D 배치 적용은 랙 위치를 반영합니다. 운송 경로와 재고·공정 조건은
            운영 모델에서 별도로 구성합니다.
          </p>
        </div>
      )}

      <details className="plan-extra plan-example-tools">
        <summary>예제 · 파일 불러오기</summary>
        <p className="plan-subtle">
          처음에는 현재 기본값으로 진행해도 됩니다. 아래 수직 예제는 실제 현장
          사양이 아닙니다.
        </p>
        <div className="plan-tool-buttons">
          <button
            className="button small"
            disabled={disabled}
            onClick={() =>
              applyVertical(
                structuredClone(EXAMPLE_INPUT),
                "첨부 예제 가정 · 실사양 아님",
              )
            }
          >
            첨부 2,699 mm 예제 적용
          </button>
          <button
            className="button small"
            disabled={disabled}
            onClick={() => verticalFileRef.current?.click()}
          >
            버티컬 사양 JSON 불러오기
          </button>
        </div>
        <input
          hidden
          type="file"
          accept="application/json,.json"
          aria-label="버티컬 사양 JSON 파일"
          ref={verticalFileRef}
          onChange={importVertical}
        />
      </details>
      <footer className="plan-wizard-footer">
        <button
          className="button"
          onClick={() => setStep(Math.max(0, step - 1) as PlanStep)}
          disabled={step === 0}
        >
          ← 이전
        </button>
        <div className="plan-footer-note">
          <strong>
            {step + 1} / {steps.length}
          </strong>
          <span>이전 단계로 돌아가 언제든 수정할 수 있습니다.</span>
        </div>
        <div className="plan-footer-actions">
          {step === 0 && (
            <button className="text-button" onClick={() => setStep(1)}>
              도면은 나중에
            </button>
          )}
          {step === 2 && (
            <button className="text-button" onClick={() => setStep(3)}>
              사양은 나중에
            </button>
          )}
          {step < 5 ? (
            <button
              className="button primary"
              onClick={() => setStep((step + 1) as PlanStep)}
            >
              다음: {steps[step + 1].label} →
            </button>
          ) : (
            onComplete && (
              <button
                className="button primary"
                onClick={onComplete}
                disabled={disabled}
              >
                시뮬레이션 실행 →
              </button>
            )
          )}
        </div>
      </footer>
      {message && (
        <div className="plan-message" role="status">
          {message}
          <button aria-label="설계 알림 닫기" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
    </section>
  );
}
