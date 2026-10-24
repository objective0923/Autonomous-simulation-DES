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
}
type PlanStep = 0 | 1 | 2 | 3;
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
    setStep(2);
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

  return (
    <section className="planning-workspace" aria-label="공간 및 랙 사전 설계">
      <div className="plan-context">
        <div>
          <span className="plan-dot" />
          <strong>도면에서 배치 후보까지</strong>
          <p>
            원본 도면과 실제 사양을 연결해 5단·6단부터 20단 이상을 비교하고,
            후보를 3D로 살펴보세요.
          </p>
        </div>
        <span className={`plan-status ${hasEvidence ? "pass" : "needsReview"}`}>
          {hasEvidence ? "입력 근거 사용자 확인" : "미확인 입력 포함"}
        </span>
      </div>
      <nav className="plan-pipeline" aria-label="사전 설계 단계">
        {[
          { label: "도면 · 축척", sub: "Source & calibration" },
          { label: "공간 · 장비 사양", sub: "Verified dimensions" },
          { label: "단수 · 인계 높이 비교", sub: "Rack & robot elevation" },
          { label: "자동 배치 · 3D", sub: "Candidate layout" },
        ].map((item, index) => (
          <button
            key={item.label}
            className={step === index ? "active" : ""}
            onClick={() => setStep(index as PlanStep)}
            aria-current={step === index ? "step" : undefined}
          >
            <b>{String(index + 1).padStart(2, "0")}</b>
            <span>
              {item.label}
              <small>{item.sub}</small>
            </span>
            <i>›</i>
          </button>
        ))}
      </nav>
      <div className="plan-integration-bar">
        <div>
          <strong>첨부 수직 모델 연결</strong>
          <p>
            mm 단위 원본 입력을 m 단위 계획으로 변환합니다. 제공된 예제는 확인된
            현장 사양을 대신하지 않습니다.
          </p>
        </div>
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
        <input
          hidden
          type="file"
          accept="application/json,.json"
          aria-label="버티컬 사양 JSON 파일"
          ref={verticalFileRef}
          onChange={importVertical}
        />
      </div>
      {disabled && (
        <p className="plan-notice">
          시뮬레이션 입력이 잠겨 있습니다. 초기화한 뒤 도면과 설계 조건을
          편집하세요.
        </p>
      )}
      {step === 0 && (
        <>
          <UiSource
            project={project}
            onChange={sourceChange}
            disabled={disabled}
          />
          <div className="plan-step-footer">
            <p>
              도면은 시각적 기준입니다. 길이 기준과 현장 치수를 확인한 뒤
              공간·장비 사양을 입력하세요.
            </p>
            <button className="button primary" onClick={() => setStep(1)}>
              공간 · 장비 사양 입력 <span>→</span>
            </button>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <div className="plan-input-grid">
            <section className="plan-card">
              <header>
                <span className="plan-card-number">A</span>
                <div>
                  <h2>건축 · 작업 공간</h2>
                  <p>벽체 안쪽의 유효 치수 기준</p>
                </div>
                <span
                  className={`plan-status ${plan.building.confirmed ? "pass" : "needsReview"}`}
                >
                  {plan.building.confirmed ? "사용자 확인" : "미확인"}
                </span>
              </header>
              <div className="plan-card-body">
                <div className="plan-two-fields">
                  <NumberField
                    label="건물 유효 가로"
                    value={plan.building.width}
                    onChange={(v) => updateNumber("building", "width", v ?? 0)}
                    disabled={disabled}
                  />
                  <NumberField
                    label="건물 유효 세로"
                    value={plan.building.depth}
                    onChange={(v) => updateNumber("building", "depth", v ?? 0)}
                    disabled={disabled}
                  />
                </div>
                <NumberField
                  label="유효 천장 높이"
                  value={plan.building.clearHeight}
                  nullable
                  onChange={(v) => updateNumber("building", "clearHeight", v)}
                  disabled={disabled}
                  detail="보·배관·스프링클러 등 최저 간섭물 아래의 실제 높이"
                />
                <div className="plan-form-info">
                  기본 평면 {fmt(plan.building.width)} ×{" "}
                  {fmt(plan.building.depth)} m는 초기 입력값입니다. 도면 축척과
                  실측 근거를 확인하세요.
                </div>
                <Evidence
                  title="공간 치수"
                  confirmed={plan.building.confirmed}
                  evidence={plan.building.evidence}
                  onEvidence={(value) =>
                    updatePlan((next) => {
                      next.building.evidence = value;
                      next.building.confirmed = false;
                    })
                  }
                  onConfirm={(value) =>
                    updatePlan((next) => {
                      next.building.confirmed = value;
                    })
                  }
                  complete={canConfirmBuilding}
                  disabled={disabled}
                />
              </div>
            </section>
            <section className="plan-card">
              <header>
                <span className="plan-card-number">B</span>
                <div>
                  <h2>로봇 · CTU 사양</h2>
                  <p>실제 모델 사양서 입력</p>
                </div>
                <span
                  className={`plan-status ${plan.robot.confirmed ? "pass" : "needsReview"}`}
                >
                  {plan.robot.confirmed ? "사용자 확인" : "미확인"}
                </span>
              </header>
              <div className="plan-card-body">
                <label className="plan-field">
                  <span>장비 방식</span>
                  <select
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
                <div className="plan-two-fields">
                  <NumberField
                    label="로봇 외형 폭"
                    value={plan.robot.width}
                    nullable
                    onChange={(v) => updateNumber("robot", "width", v)}
                    disabled={disabled}
                  />
                  <NumberField
                    label="로봇 외형 길이"
                    value={plan.robot.length}
                    nullable
                    onChange={(v) => updateNumber("robot", "length", v)}
                    disabled={disabled}
                  />
                </div>
                <NumberField
                  label="최소 작업 통로 폭"
                  value={plan.robot.minAisleWidth}
                  nullable
                  onChange={(v) => updateNumber("robot", "minAisleWidth", v)}
                  disabled={disabled}
                  detail="제조사 기준 회전·인계·적재물 외형을 포함한 요구 폭"
                />
                <label className="plan-field">
                  <span>인계 방식</span>
                  <select
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
                    <option value="fixedLevels">
                      고정된 선반 높이에서 인계
                    </option>
                  </select>
                </label>
                <p className="plan-demo-note">
                  연속 승강형은 접근 가능한 최소·최고 높이를 검사합니다. 내부
                  선반 수와 랙 단수가 같을 필요는 없습니다. 고정 인계형은 랙의
                  각 선반과 장비 인계 단의 높이를 허용 오차 내에서 대조합니다.
                </p>
                <NumberField
                  label="최저 인계 가능 높이"
                  value={plan.robot.minTransferHeight}
                  nullable
                  onChange={(v) =>
                    updateNumber("robot", "minTransferHeight", v)
                  }
                  disabled={disabled}
                />
                <div className="plan-two-fields">
                  <NumberField
                    label="최고 인계 가능 높이"
                    value={plan.robot.maxLiftHeight}
                    nullable
                    onChange={(v) => updateNumber("robot", "maxLiftHeight", v)}
                    disabled={disabled}
                  />
                  <NumberField
                    label="최대 적재 중량"
                    unit="kg"
                    value={plan.robot.maxPayloadKg}
                    nullable
                    step={10}
                    onChange={(v) => updateNumber("robot", "maxPayloadKg", v)}
                    disabled={disabled}
                  />
                </div>
                <NumberField
                  label="마스트 최대 상승 전고"
                  value={plan.robot.overallHeight}
                  nullable
                  onChange={(v) => updateNumber("robot", "overallHeight", v)}
                  disabled={disabled}
                  detail="장비 자체의 최고 높이입니다. 최고 인계 가능 높이와 별도로 천장 간섭을 검사합니다."
                />
                <div className="plan-robot-shelves">
                  <h3>로봇 내부 선반 · 고정 인계 단</h3>
                  <div className="plan-two-fields">
                    <NumberField
                      label="장비 첫 선반 높이"
                      value={plan.robot.firstShelfHeight}
                      nullable
                      onChange={(v) =>
                        updateNumber("robot", "firstShelfHeight", v)
                      }
                      disabled={disabled}
                    />
                    <NumberField
                      label="장비 선반 피치"
                      value={plan.robot.shelfPitch}
                      nullable
                      onChange={(v) => updateNumber("robot", "shelfPitch", v)}
                      disabled={disabled}
                    />
                    <NumberField
                      label="장비 내부 선반 수"
                      unit="단"
                      value={plan.robot.shelfCount}
                      nullable
                      step={1}
                      onChange={(v) => updateNumber("robot", "shelfCount", v)}
                      disabled={disabled}
                    />
                    <NumberField
                      label="고정 인계 높이 오차"
                      value={plan.robot.alignmentTolerance}
                      step={0.001}
                      onChange={(v) =>
                        updateNumber("robot", "alignmentTolerance", v ?? 0)
                      }
                      disabled={disabled}
                    />
                  </div>
                  <p className="plan-demo-note">
                    장비 첫 선반 높이는 최저 인계 가능 높이와 다른 사양입니다.
                    내부 선반 높이를 임의로 승강 범위와 동일하게 가정하지
                    않습니다.
                  </p>
                </div>
                <button
                  className="button small"
                  disabled={disabled}
                  onClick={demoRobot}
                >
                  DEMO 로봇 가정값 입력
                </button>
                <p className="plan-demo-note">
                  실제 장비가 정해지지 않았다면 가정으로 비교할 수 있습니다.
                  DEMO 수치는 확인 상태로 저장되지 않습니다.
                </p>
                <Evidence
                  title="로봇 사양"
                  confirmed={plan.robot.confirmed}
                  evidence={plan.robot.evidence}
                  onEvidence={(value) =>
                    updatePlan((next) => {
                      next.robot.evidence = value;
                      next.robot.confirmed = false;
                    })
                  }
                  onConfirm={(value) =>
                    updatePlan((next) => {
                      next.robot.confirmed = value;
                    })
                  }
                  complete={canConfirmRobot}
                  disabled={disabled}
                />
              </div>
            </section>
            <section className="plan-card">
              <header>
                <span className="plan-card-number">C</span>
                <div>
                  <h2>랙 · 운송물 조건</h2>
                  <p>임의 단수 비교의 공통 조건</p>
                </div>
                <span
                  className={`plan-status ${plan.rack.confirmed ? "pass" : "needsReview"}`}
                >
                  {plan.rack.confirmed ? "사용자 확인" : "미확인"}
                </span>
              </header>
              <div className="plan-card-body">
                <label className="plan-field">
                  <span>랙 높이 산정 방식</span>
                  <select
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
                    <option value="minimum">
                      운송물·빔·인출 여유로 최소 피치 산정
                    </option>
                  </select>
                </label>
                {plan.rack.heightMode === "totalHeight" && (
                  <NumberField
                    label="랙 구조 총높이"
                    value={plan.rack.totalHeight}
                    nullable
                    onChange={(v) => updateNumber("rack", "totalHeight", v)}
                    disabled={disabled}
                    detail="첫 선반부터 마지막 단 위 상단 빔까지 포함한 구조 높이"
                  />
                )}
                <div className="plan-two-fields">
                  <NumberField
                    label="랙 모듈 가로"
                    value={plan.rack.width}
                    onChange={(v) => updateNumber("rack", "width", v ?? 0)}
                    disabled={disabled}
                  />
                  <NumberField
                    label="랙 모듈 깊이"
                    value={plan.rack.depth}
                    onChange={(v) => updateNumber("rack", "depth", v ?? 0)}
                    disabled={disabled}
                  />
                  <NumberField
                    label="첫 선반 높이"
                    value={plan.rack.firstShelfHeight}
                    onChange={(v) =>
                      updateNumber("rack", "firstShelfHeight", v ?? 0)
                    }
                    disabled={disabled}
                  />
                  <NumberField
                    label={
                      plan.rack.heightMode === "pitch"
                        ? "선반 간 피치"
                        : "지정 피치 (현재 모드 미사용)"
                    }
                    value={plan.rack.shelfPitch}
                    onChange={(v) => updateNumber("rack", "shelfPitch", v ?? 0)}
                    disabled={disabled || plan.rack.heightMode !== "pitch"}
                  />
                  <NumberField
                    label="운송물 높이"
                    value={plan.rack.loadHeight}
                    onChange={(v) => updateNumber("rack", "loadHeight", v ?? 0)}
                    disabled={disabled}
                  />
                  <NumberField
                    label="상부 여유 높이"
                    value={plan.rack.topClearance}
                    onChange={(v) =>
                      updateNumber("rack", "topClearance", v ?? 0)
                    }
                    disabled={disabled}
                  />
                  <NumberField
                    label="인계 상승 여유"
                    value={plan.rack.liftClearance}
                    onChange={(v) =>
                      updateNumber("rack", "liftClearance", v ?? 0)
                    }
                    disabled={disabled}
                  />
                  <NumberField
                    label="선반 빔 두께"
                    value={plan.rack.beamThickness}
                    step={0.01}
                    onChange={(v) =>
                      updateNumber("rack", "beamThickness", v ?? 0)
                    }
                    disabled={disabled}
                  />
                  <NumberField
                    label="운송물 중량"
                    unit="kg"
                    value={plan.rack.unitLoadKg}
                    step={10}
                    onChange={(v) => updateNumber("rack", "unitLoadKg", v ?? 0)}
                    disabled={disabled}
                  />
                </div>
                <NumberField
                  label="선반당 허용 중량"
                  unit="kg"
                  value={plan.rack.shelfCapacityKg}
                  step={10}
                  onChange={(v) =>
                    updateNumber("rack", "shelfCapacityKg", v ?? 0)
                  }
                  disabled={disabled}
                />
                <Evidence
                  title="랙 · 운송물 조건"
                  confirmed={plan.rack.confirmed}
                  evidence={plan.rack.evidence}
                  onEvidence={(value) =>
                    updatePlan((next) => {
                      next.rack.evidence = value;
                      next.rack.confirmed = false;
                    })
                  }
                  onConfirm={(value) =>
                    updatePlan((next) => {
                      next.rack.confirmed = value;
                    })
                  }
                  complete={canConfirmRack}
                  disabled={disabled}
                />
              </div>
            </section>
          </div>
          <div className="plan-step-footer">
            <p>수치를 수정하면 관련 확인 상태와 기존 배치 후보가 해제됩니다.</p>
            <button className="button primary" onClick={() => setStep(2)}>
              단수 · 인계 높이 비교 <span>→</span>
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <div className="plan-compare-targets">
            <div>
              <h2>비교할 랙 단수</h2>
              <p>
                1~100단의 정수를 입력하세요. 선반 피치·첫 선반과 건축·장비
                사양을 함께 검사합니다.
              </p>
            </div>
            <NumberField
              label="대안 A 단수"
              unit="단"
              value={candidateA}
              step={1}
              onChange={(v) =>
                setCandidateA(Math.max(1, Math.min(100, Math.floor(v ?? 5))))
              }
            />
            <NumberField
              label="대안 B 단수"
              unit="단"
              value={candidateB}
              step={1}
              onChange={(v) =>
                setCandidateB(Math.max(1, Math.min(100, Math.floor(v ?? 6))))
              }
            />
          </div>
          <div className="plan-vertical-capacity">
            <div>
              <span>계산 기준 최대 단수</span>
              <strong>
                {fmt(vertical.max, 0)}
                <small>단</small>
              </strong>
            </div>
            <div>
              <span>공간 기준</span>
              <b>{fmt(vertical.byHeight, 0)}단</b>
            </div>
            <div>
              <span>인계 기준</span>
              <b>{fmt(vertical.byLift, 0)}단</b>
            </div>
            <div>
              <span>지배 제약</span>
              <b>
                {
                  {
                    space: "건물 공간",
                    robot: "로봇 인계",
                    both: "공간·인계 동시",
                    unknown: "추가 입력 필요",
                  }[vertical.binding]
                }
              </b>
            </div>
            <p>
              높이 조건만의 상한이며 하중·고정 인계단 매칭·근거 확인은 대안별로
              별도 검사합니다. 다음 단 구조에 필요한 천장{" "}
              {fmt(vertical.spaceHeightForNext)} m · 작업면{" "}
              {fmt(vertical.workSurfaceMaxForNext)} m.
            </p>
          </div>
          <div className="plan-comparison-grid">
            {comparisons.map((comparison) => (
              <section
                className={`plan-level-card ${comparison.status}`}
                key={comparison.levels}
              >
                <header>
                  <div>
                    <span>RACK ALTERNATIVE</span>
                    <h2>
                      {comparison.levels}
                      <small>단 구성</small>
                    </h2>
                  </div>
                  <span className={`plan-status ${comparison.status}`}>
                    {statusText[comparison.status]}
                  </span>
                </header>
                <div className="plan-level-metrics">
                  <div>
                    <span>랙 구조 총높이</span>
                    <strong>
                      {fmt(comparison.totalHeight)}
                      <small>m</small>
                    </strong>
                  </div>
                  <div>
                    <span>필요 유효 천장</span>
                    <strong>
                      {fmt(comparison.requiredClearHeight)}
                      <small>m</small>
                    </strong>
                  </div>
                  <div>
                    <span>필요 인계 높이</span>
                    <strong>
                      {fmt(comparison.requiredLiftHeight)}
                      <small>m</small>
                    </strong>
                  </div>
                </div>
                <div className="plan-formulas">
                  <p>
                    산정 피치 <b>{fmt(comparison.pitch)} m</b> · 최소 피치{" "}
                    <b>{fmt(comparison.minPitch)} m</b> (운송물 + 인출 여유 +
                    빔)
                  </p>
                  <p>
                    최상단 선반 = {fmt(plan.rack.firstShelfHeight)} + (
                    {comparison.levels} − 1) × {fmt(comparison.pitch)} ={" "}
                    <b>{fmt(comparison.topShelfHeight)} m</b>
                  </p>
                  <p>
                    랙 구조 총높이 = {fmt(plan.rack.firstShelfHeight)} +{" "}
                    {comparison.levels} × {fmt(comparison.pitch)} ={" "}
                    <b>{fmt(comparison.totalHeight)} m</b>
                  </p>
                  <p>
                    필요 천장 = 구조 총높이 + 상부 여유{" "}
                    {fmt(plan.rack.topClearance)} ={" "}
                    <b>{fmt(comparison.requiredClearHeight)} m</b>
                  </p>
                  <p>
                    필요 인계 = 최상단 선반 + 상승 여유{" "}
                    {fmt(plan.rack.liftClearance)} ={" "}
                    <b>{fmt(comparison.requiredLiftHeight)} m</b>
                  </p>
                  <p>
                    단 내 운송물 위 여유{" "}
                    <b>{fmt(comparison.clearanceAbove)} m</b> · 천장 잔여{" "}
                    <b>{fmt(comparison.headroom)} m</b>
                  </p>
                </div>
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
                      <span>
                        {check.status === "pass"
                          ? "충족"
                          : check.status === "fail"
                            ? "미충족"
                            : "확인"}
                      </span>
                    </li>
                  ))}
                </ul>
                <footer>
                  <button
                    className={`button ${plan.layout.requestedLevels === comparison.levels ? "primary" : ""}`}
                    disabled={disabled}
                    onClick={() =>
                      updatePlan((next) => {
                        next.layout.requestedLevels = comparison.levels;
                      })
                    }
                  >
                    {plan.layout.requestedLevels === comparison.levels
                      ? "선택됨"
                      : `${comparison.levels}단 배치로 선택`}
                  </button>
                </footer>
              </section>
            ))}
          </div>
          <div className="plan-elevation-section">
            <div className="plan-elevation-selection">
              <div>
                <h2>선택 대안의 인계 높이</h2>
                <p>
                  랙과 로봇을 같은 바닥 기준으로 비교합니다. 대안을 선택하거나
                  단수를 직접 바꿀 수 있습니다.
                </p>
              </div>
              <NumberField
                label="측면도 기준 단수"
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
            </div>
            <UiElevation plan={plan} levels={plan.layout.requestedLevels} />
          </div>
          <div className="plan-comparison-note">
            <strong>판정의 의미</strong>
            <p>
              ‘입력 기준 충족’은 기입한 수치와 사용자 확인 근거로 계산한 사전
              검토 결과입니다. 구조 하중, 내진, 소방·피난, 방호와 실제 운행
              검증은 별도 설계 검토가 필요합니다. 로봇 사양이나 천장 높이가
              없으면 적합 판정을 만들지 않습니다.
            </p>
          </div>
          <div className="plan-step-footer">
            <p>
              선택 구성: <b>{plan.layout.requestedLevels}단</b> ·{" "}
              {activeComparison
                ? statusText[activeComparison.status]
                : "확인 필요"}
            </p>
            <button className="button primary" onClick={() => setStep(3)}>
              배치 후보 · 3D 확인 <span>→</span>
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <div className="plan-layout-grid">
            <aside className="plan-card plan-layout-controls">
              <header>
                <span className="plan-card-number">D</span>
                <div>
                  <h2>배치 후보 생성</h2>
                  <p>규칙 기반 방향·열 배치 비교</p>
                </div>
              </header>
              <div className="plan-card-body">
                <NumberField
                  label="선택 랙 단수 (1~100)"
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
                <div className="plan-layout-reference">
                  <span>장비 작업 통로</span>
                  <strong>{fmt(plan.robot.minAisleWidth)} m</strong>
                  <small>장비 사양 탭에서 실제 요구 폭을 입력하세요.</small>
                </div>
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
                <button
                  className="button primary full"
                  onClick={generate}
                  disabled={disabled}
                >
                  배치 후보 생성
                </button>
                <p className="plan-demo-note">
                  기존 2D 객체의 외곽을 제외 영역으로 사용합니다. 벽·기둥·설비는
                  먼저 2D 화면에 배치하세요. 전체 최적해를 보장하지 않는
                  휴리스틱 후보입니다.
                </p>
                <div className="plan-layout-stat">
                  <span>저장된 랙 후보</span>
                  <strong>
                    {placements.length}
                    <small>개</small>
                  </strong>
                </div>
                <div className="plan-layout-stat">
                  <span>선택 {plan.layout.requestedLevels}단 기하 용량</span>
                  <strong>
                    {fmt(
                      proposal?.capacityUnits ??
                        placements.length * plan.layout.requestedLevels,
                      0,
                    )}
                    <small>위치</small>
                  </strong>
                </div>
                <div className="plan-capacity-grid">
                  <div>
                    <span>5단 기하 용량</span>
                    <b>
                      {fmt(proposal?.capacity5 ?? placements.length * 5, 0)}
                    </b>
                  </div>
                  <div>
                    <span>6단 기하 용량</span>
                    <b>
                      {fmt(proposal?.capacity6 ?? placements.length * 6, 0)}
                    </b>
                  </div>
                </div>
                <div className="plan-max-levels">
                  <span>
                    입력 천장 기준 최대{" "}
                    <b>{fmt(proposal?.maxLevelsByHeight, 0)}단</b>
                  </span>
                  <span>
                    입력 인계 높이 기준 최대{" "}
                    <b>{fmt(proposal?.maxLevelsByLift, 0)}단</b>
                  </span>
                </div>
                <p className="plan-demo-note">
                  선반 1개당 운송물 1개 가정의 위치 수입니다. 높이·하중 미충족
                  대안은 운영 가능한 용량으로 해석하지 마세요.
                </p>
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
                <p className="plan-demo-note">
                  이 버튼은 계획 랙 객체만 교체합니다. DES 노드·경로·버퍼·운송
                  작업은 자동 생성하지 않습니다.
                </p>
              </div>
            </aside>
            <section className="plan-scene-card">
              <div className="plan-scene-heading">
                <div>
                  <span>SPATIAL REVIEW</span>
                  <h2>3D 배치 · 높이 검토</h2>
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
              <div className="plan-scene-caption">
                <span>
                  {fmt(plan.building.width)} × {fmt(plan.building.depth)} m ·
                  천장 {fmt(plan.building.clearHeight)} m
                </span>
                <span>
                  {plan.layout.requestedLevels}단 · 랙 {placements.length}개
                </span>
              </div>
            </section>
          </div>
          {proposal && (
            <section className="plan-proposal-report">
              <div>
                <h3>후보 생성 근거</h3>
                <span className="tiny-pill">
                  {proposal.candidateCount} CANDIDATES
                </span>
                <span className="tiny-pill">
                  방향 {String(proposal.orientation)}°
                </span>
              </div>
              {proposal.issues.length > 0 && (
                <ul>
                  {proposal.issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
              <p>{proposal.assumptions.join(" · ")}</p>
            </section>
          )}
        </>
      )}
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
