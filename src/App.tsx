import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { runSimulation, ENGINE_VERSION } from "./api";
import { SimulationPlayback } from "./playback";
import { createExampleProject } from "./examples";
import { cloneProject, parseProject, validateProject } from "./model";
import { eventsToCsv } from "./analysis";
import { parseSavedRun } from "./replay";
import UiMap from "./UiMap";
import UiPlanning from "./UiPlanning";
import { applyDrawingSource } from "./source";
import UiScenarioLibrary, { type ScenarioImport } from "./UiScenarioLibrary";
import {
  createScenario,
  updateScenario,
  listScenarios,
  scenarioKey,
  type ScenarioDetail,
} from "./scenarios";
import type {
  Distribution,
  MapObject,
  Project,
  RobotStatus,
  SimulationResult,
  Snapshot,
} from "./types";

type Page = "library" | "planning" | "edit" | "monitor" | "results";
type Panel =
  | "selection"
  | "conditions"
  | "robots"
  | "production"
  | "resources"
  | "json";
const STORAGE_KEY = "crois.project.v1";
const statusNames: Record<RobotStatus, string> = {
  idle: "대기",
  emptyTravel: "공차 이동",
  loading: "적재",
  loadedTravel: "적재 이동",
  unloading: "하역",
  trafficWait: "교통 대기",
  equipmentWait: "설비 대기",
  chargeWait: "충전 대기",
  docking: "도킹",
  charging: "충전",
  undocking: "충전 이탈",
  failed: "고장",
};
const statusColors: Record<RobotStatus, string> = {
  idle: "#94a3b8",
  emptyTravel: "#38bdf8",
  loading: "#a78bfa",
  loadedTravel: "#14b8a6",
  unloading: "#8b5cf6",
  trafficWait: "#f59e0b",
  equipmentWait: "#fb923c",
  chargeWait: "#eab308",
  docking: "#2dd4bf",
  charging: "#22c55e",
  undocking: "#2dd4bf",
  failed: "#ef4444",
};
const number = (n: number | undefined, digits = 1) =>
  Number.isFinite(n)
    ? Number(n).toLocaleString("ko-KR", { maximumFractionDigits: digits })
    : "—";
const seconds = (n: number) =>
  `${String(Math.floor(n / 3600)).padStart(2, "0")}:${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
function download(name: string, data: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function initialProject(): Project {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return parseProject(JSON.parse(saved));
  } catch {
    /* Invalid local copies never replace the example. */
  }
  return createExampleProject();
}
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v17h17M8 15V9m5 6V5m5 10v-5" />
      </>
    ),
    edit: (
      <>
        <path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15Z" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    save: (
      <>
        <path d="M4 3h13l4 4v14H3V3Zm3 0v7h10V3M7 21v-7h10v7" />
      </>
    ),
    upload: (
      <>
        <path d="M12 17V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    robot: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="3" />
        <path d="M12 3v4M8 13h.01M16 13h.01M8 17h8M1 11v5m22-5v5" />
      </>
    ),
    check: <path d="m5 12 4 4L20 5" />,
    plus: <path d="M12 4v16M4 12h16" />,
    node: (
      <>
        <circle cx="12" cy="12" r="6" />
        <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
      </>
    ),
    route: (
      <>
        <circle cx="5" cy="5" r="2" />
        <circle cx="19" cy="19" r="2" />
        <path d="M5 7v6h14v4" />
      </>
    ),
    box: (
      <>
        <path d="m3 7 9-4 9 4v10l-9 4-9-4Zm0 0 9 5 9-5M12 12v9" />
      </>
    ),
    cursor: <path d="m4 3 6 17 3-7 7-3Z" />,
    undo: (
      <>
        <path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 7 7v4" />
      </>
    ),
    redo: (
      <>
        <path d="m16 4 5 5-5 5m5-5H11a7 7 0 0 0-7 7v4" />
      </>
    ),
    step: (
      <>
        <path d="m5 5 10 7-10 7Zm14 0v14" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7Z" />,
    file: (
      <>
        <path d="M14 2H5v20h14V7Zm0 0v6h5M8 12h8m-8 4h8" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.grid}
    </svg>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Num({
  value,
  onChange,
  min = 0,
  step = 1,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        if (
          e.currentTarget.value !== "" &&
          Number.isFinite(e.currentTarget.valueAsNumber)
        )
          onChange(e.currentTarget.valueAsNumber);
      }}
    />
  );
}
function DistributionEditor({
  value,
  onChange,
}: {
  value: Distribution;
  onChange: (d: Distribution) => void;
}) {
  const defaults: Record<Distribution["kind"], Distribution> = {
    fixed: { kind: "fixed", value: 30 },
    uniform: { kind: "uniform", min: 20, max: 40 },
    triangular: { kind: "triangular", min: 20, mode: 30, max: 45 },
    normal: { kind: "normal", mean: 30, sd: 5, min: 10, max: 60 },
    lognormal: { kind: "lognormal", mu: 3, sigma: 0.3 },
    exponential: { kind: "exponential", mean: 30 },
    empirical: { kind: "empirical", values: [20, 30, 40] },
  };
  const labels: Record<string, string> = {
    value: "고정 시간 (s)",
    min: "최솟값 (s)",
    max: "최댓값 (s)",
    mode: "최빈값 (s)",
    mean: "평균 (s)",
    sd: "표준편차 (s)",
    mu: "ln(초) 평균 μ",
    sigma: "ln(초) 표준편차 σ",
  };
  return (
    <>
      <Field label="처리시간 분포">
        <select
          value={value.kind}
          onChange={(e) =>
            onChange(defaults[e.target.value as Distribution["kind"]])
          }
        >
          <option value="fixed">고정값</option>
          <option value="uniform">균등분포</option>
          <option value="triangular">삼각분포</option>
          <option value="normal">절단 정규분포</option>
          <option value="lognormal">로그정규분포</option>
          <option value="exponential">지수분포</option>
          <option value="empirical">실측 샘플</option>
        </select>
      </Field>
      <div className="field-grid">
        {Object.entries(value)
          .filter(([k]) => k !== "kind")
          .map(([k, v]) => (
            <Field key={k} label={labels[k] ?? "시간 샘플 (s, 쉼표로 구분)"}>
              {Array.isArray(v) ? (
                <input
                  value={v.join(", ")}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      values: e.target.value.split(",").map(Number),
                    } as Distribution)
                  }
                />
              ) : (
                <Num
                  value={v as number}
                  step={0.1}
                  min={k === "mu" ? -100 : 0}
                  onChange={(n) =>
                    onChange({ ...value, [k]: n } as Distribution)
                  }
                />
              )}
            </Field>
          ))}
      </div>
      <small className="muted">
        시간 ≥ 0. 균등·삼각·정규는 min ≤ max, 삼각은 min ≤ mode ≤ max. 지수 mean
        &gt; 0. 로그정규 μ·σ는 로그 공간 값입니다.
      </small>
    </>
  );
}

export default function App() {
  const [project, setProject] = useState<Project>(initialProject);
  const savedText = useRef(JSON.stringify(project));
  const projectRef = useRef(project);
  projectRef.current = project;
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const activeScenarioRef = useRef<string | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [pendingImport, setPendingImport] = useState<ScenarioImport | null>(
    null,
  );
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "pending" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState("");
  const failedSave = useRef(false);
  const [latestResult, setLatestResult] = useState<SimulationResult | null>(
    null,
  );
  const saveTail = useRef<Promise<unknown>>(Promise.resolve());
  const queuedSave = useRef<{
    id: string;
    text: string;
    promise: Promise<void>;
  } | null>(null);
  const [legacyProject] = useState<Project | null>(() => {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value ? parseProject(JSON.parse(value)) : null;
    } catch {
      return null;
    }
  });
  const [past, setPast] = useState<Project[]>([]),
    [future, setFuture] = useState<Project[]>([]);
  const [page, setPage] = useState<Page>("library"),
    [panel, setPanel] = useState<Panel>("selection");
  const [selected, setSelected] = useState<string[]>([]),
    [tool, setTool] = useState<"select" | "node" | "edge" | "object">("select");
  const [objectKind, setObjectKind] = useState<MapObject["kind"]>("rack"),
    [snap, setSnap] = useState(true),
    [zoom, setZoom] = useState(1);
  const [mapRevision, setMapRevision] = useState(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const backgroundGeneration = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [result, setResult] = useState<SimulationResult | null>(null),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(20);
  const engineRef = useRef<SimulationPlayback | null>(null);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef<Promise<SimulationPlayback | null> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  useEffect(() => () => requestRef.current?.abort(), []);
  const [replayIndex, setReplayIndex] = useState<number | null>(null),
    [notice, setNotice] = useState(""),
    [jsonDraft, setJsonDraft] = useState(""),
    [eventFilter, setEventFilter] = useState("");
  const [comparisons, setComparisons] = useState<
    Array<{ label: string; result: SimulationResult }>
  >([]);
  const [saveRevision, forceSaved] = useState(0);
  const importRef = useRef<HTMLInputElement>(null),
    backgroundRef = useRef<HTMLInputElement>(null);
  const issues = useMemo(() => validateProject(project), [project]);
  const errors = issues.filter((i) => i.severity === "error");
  const locked = engineRef.current !== null || result !== null || loading;
  const dirty = JSON.stringify(project) !== savedText.current;
  const displaySnapshot =
    replayIndex !== null && result?.history[replayIndex]
      ? result.history[replayIndex]
      : snapshot;
  const active =
    displaySnapshot?.robots.filter(
      (r) => !["idle", "charging", "chargeWait", "failed"].includes(r.status),
    ).length ?? 0;
  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(id);
  }, [notice]);
  const change = useCallback(
    (next: Project) => {
      if (engineRef.current || loadingRef.current) return;
      setPast((p) => [...p.slice(-49), project]);
      setFuture([]);
      projectRef.current = next;
      setProject(next);
      setLatestResult(null);
    },
    [project],
  );
  const mutate = (fn: (p: Project) => void) => {
    const p = cloneProject(project);
    fn(p);
    change(p);
  };
  const clearRun = () => {
    generationRef.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    loadingRef.current = null;
    setLoading(false);
    setPlaying(false);
    engineRef.current = null;
    setSnapshot(null);
    setResult(null);
    setReplayIndex(null);
  };
  const newProject = () => {
    void goLibrary(true);
  };
  const initEngine = async (): Promise<SimulationPlayback | null> => {
    if (engineRef.current) return engineRef.current;
    if (loadingRef.current) return loadingRef.current;
    if (result) {
      notify("저장된 실행을 보고 있습니다. 초기화 후 새 계산을 시작하세요.");
      return null;
    }
    const scenarioId = activeScenarioRef.current;
    if (!scenarioId) {
      notify("먼저 고객 이름과 시나리오 이름으로 시나리오를 만들어 주세요.");
      return null;
    }
    if (errors.length) {
      notify(`실행 전 오류 ${errors.length}개를 해결해 주세요.`);
      setPanel("conditions");
      return null;
    }
    // Reserve the entire save-and-calculate operation before the first await.
    const controller = new AbortController();
    const generation = ++generationRef.current;
    requestRef.current = controller;
    setLoading(true);
    const pending = Promise.resolve()
      .then(async () => {
        await flushSave();
        if (
          controller.signal.aborted ||
          generation !== generationRef.current ||
          activeScenarioRef.current !== scenarioId
        )
          return null;
        const input = cloneProject(projectRef.current);
        const computed = await runSimulation(input, controller.signal);
        if (
          controller.signal.aborted ||
          generation !== generationRef.current ||
          activeScenarioRef.current !== scenarioId
        )
          return null;
        const playback = new SimulationPlayback(input, computed);
        engineRef.current = playback;
        setLatestResult(computed);
        setLibraryRevision((value) => value + 1);
        setSnapshot(playback.getSnapshot());
        setReplayIndex(null);
        return playback;
      })
      .catch((error) => {
        if (controller.signal.aborted || generation !== generationRef.current)
          return null;
        throw error;
      })
      .finally(() => {
        if (generation === generationRef.current) {
          requestRef.current = null;
          loadingRef.current = null;
          setLoading(false);
        }
      });
    loadingRef.current = pending;
    return pending;
  };
  const finishState = (e: SimulationPlayback, s: Snapshot) => {
    setSnapshot(s);
    if (s.finished) {
      setPlaying(false);
      setResult(e.getResult());
    }
  };
  const play = async () => {
    if (loadingRef.current) return;
    try {
      const e = await initEngine();
      if (!e) return;
      setPage("monitor");
      setReplayIndex(null);
      if (e.getSnapshot().finished) {
        notify("실행이 끝났습니다. 초기화 후 다시 실행하세요.");
        return;
      }
      setPlaying((v) => !v);
    } catch (e) {
      notify(String(e));
    }
  };
  const step = async () => {
    if (loadingRef.current) return;
    try {
      setPlaying(false);
      const e = await initEngine();
      if (e) {
        setPage("monitor");
        setReplayIndex(null);
        finishState(e, e.step());
      }
    } catch (e) {
      notify(String(e));
    }
  };
  const fastRun = async () => {
    if (loadingRef.current) return;
    if (result) {
      setPage("results");
      return;
    }
    try {
      setPlaying(false);
      const e = await initEngine();
      if (e) {
        const r = e.run();
        setSnapshot(r.finalState);
        setResult(r);
        setReplayIndex(null);
        setPage("results");
        notify(`계산 완료 · 이벤트 ${number(r.events.length, 0)}건`);
      }
    } catch (e) {
      setPlaying(false);
      notify(String(e));
    }
  };
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      try {
        finishState(
          e,
          e.runUntil(
            Math.min(
              project.settings.duration,
              e.getSnapshot().time + speed / 10,
            ),
            2000,
          ),
        );
      } catch (error) {
        setPlaying(false);
        notify(String(error));
      }
    }, 100);
    return () => clearInterval(timer);
  }, [playing, speed, project.settings.duration, notify]);
  const saveSnapshot = (input: Project): Promise<void> => {
    const id = activeScenarioRef.current;
    if (!id || input.id !== id) return Promise.resolve();
    const text = JSON.stringify(input);
    if (
      text === savedText.current &&
      !failedSave.current &&
      !queuedSave.current
    )
      return Promise.resolve();
    if (queuedSave.current?.id === id && queuedSave.current.text === text)
      return queuedSave.current.promise;
    setSaveStatus("saving");
    setSaveError("");
    const task = saveTail.current
      .catch(() => {})
      .then(() => updateScenario(input))
      .then((record) => {
        if (activeScenarioRef.current !== id) return;
        const confirmed = JSON.stringify(record.project);
        if (JSON.stringify(projectRef.current) === text && confirmed !== text) {
          projectRef.current = cloneProject(record.project);
          setProject(projectRef.current);
        }
        savedText.current = confirmed;
        failedSave.current = false;
        forceSaved((value) => value + 1);
        setSaveStatus(
          JSON.stringify(projectRef.current) === confirmed
            ? "saved"
            : "pending",
        );
        setLibraryRevision((value) => value + 1);
      })
      .catch((error) => {
        if (activeScenarioRef.current === id) {
          failedSave.current = true;
          setSaveStatus("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      })
      .finally(() => {
        if (queuedSave.current?.promise === task) queuedSave.current = null;
      });
    saveTail.current = task;
    queuedSave.current = { id, text, promise: task };
    return task;
  };
  const flushSave = async () => {
    const id = activeScenarioRef.current;
    if (!id) return;
    while (activeScenarioRef.current === id) {
      await saveTail.current.catch(() => {});
      if (
        JSON.stringify(projectRef.current) === savedText.current &&
        !failedSave.current
      )
        return;
      await saveSnapshot(cloneProject(projectRef.current));
    }
  };
  useEffect(() => {
    if (
      !activeScenarioId ||
      (JSON.stringify(project) === savedText.current &&
        !failedSave.current &&
        !queuedSave.current)
    )
      return;
    setSaveStatus("pending");
    const timer = setTimeout(() => {
      void saveSnapshot(cloneProject(project)).catch(() => {});
    }, 650);
    return () => clearTimeout(timer);
  }, [project, activeScenarioId, saveRevision]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        activeScenarioRef.current &&
        JSON.stringify(projectRef.current) !== savedText.current
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const save = async () => {
    try {
      if (!activeScenarioRef.current) {
        await goLibrary();
        return;
      }
      await flushSave();
      notify("고객별 저장함에 시나리오를 저장했습니다.");
    } catch (error) {
      notify(
        `저장 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const installScenario = (
    record: ScenarioDetail,
    showResult = false,
    importedResult?: SimulationResult,
  ) => {
    clearRun();
    const next = cloneProject(record.project);
    activeScenarioRef.current = record.id;
    setActiveScenarioId(record.id);
    projectRef.current = next;
    setProject(next);
    savedText.current = JSON.stringify(next);
    setSaveStatus("saved");
    setSaveError("");
    failedSave.current = false;
    setPast([]);
    setFuture([]);
    setSelected([]);
    setPendingImport(null);
    setLatestResult(record.result);
    backgroundGeneration.current++;
    setWorkspaceRevision((value) => value + 1);
    const recorded = importedResult ?? record.result;
    if (showResult && recorded) {
      setResult(recorded);
      setSnapshot(recorded.finalState);
      setPage("results");
    } else setPage("planning");
  };
  const goLibrary = async (fresh = false) => {
    try {
      await flushSave();
      setPlaying(false);
      if (loadingRef.current) clearRun();
      if (fresh) setPendingImport(null);
      setLibraryRevision((value) => value + 1);
      setPage("library");
    } catch (error) {
      notify(
        `먼저 저장을 완료해 주세요: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const createNamedScenario = async (
    customer: string,
    name: string,
    template?: ScenarioImport,
  ) => {
    await flushSave();
    const input = cloneProject(template?.project ?? createExampleProject());
    const oldId = input.id;
    input.id = crypto.randomUUID();
    input.customerName = customer;
    input.name = name;
    const record = await createScenario(input);
    let importedResult: SimulationResult | undefined;
    if (template?.result) {
      importedResult = structuredClone(template.result);
      importedResult.projectId = input.id;
      importedResult.scenarioId = input.id;
      importedResult.runId = `${input.id}-imported-${oldId}`;
    }
    installScenario(record, Boolean(importedResult), importedResult);
    setLibraryRevision((value) => value + 1);
    notify("시나리오를 만들었습니다. 다음 입력부터 자동 저장됩니다.");
  };
  const openScenario = async (record: ScenarioDetail, showResult = false) => {
    await flushSave();
    installScenario(record, showResult);
  };
  const copyScenario = async (record: ScenarioDetail) => {
    await flushSave();
    const list = await listScenarios();
    const used = new Set(
      list
        .filter(
          (s) =>
            scenarioKey(s.customerName) === scenarioKey(record.customerName),
        )
        .map((s) => scenarioKey(s.name)),
    );
    const copyName = (index: number) => {
      const suffix = index === 1 ? " 복사" : ` 복사 ${index}`;
      return (
        Array.from(record.name)
          .slice(0, 120 - suffix.length)
          .join("") + suffix
      );
    };
    let suffix = 1,
      name = copyName(suffix);
    while (used.has(scenarioKey(name))) name = copyName(++suffix);
    await createNamedScenario(record.customerName, name, {
      project: record.project,
    });
  };
  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await flushSave();
      const data: unknown = JSON.parse(await file.text());
      if (
        data &&
        typeof data === "object" &&
        "input" in data &&
        "result" in data
      ) {
        const saved = parseSavedRun(data);
        if (
          saved.input.id === activeScenarioRef.current &&
          JSON.stringify(saved.input) === savedText.current
        ) {
          clearRun();
          setResult(saved.result);
          setSnapshot(saved.result.finalState);
          setPage("results");
          notify("실행 기록을 불러왔습니다. 새 계산 없이 재생합니다.");
        } else {
          setPendingImport({ project: saved.input, result: saved.result });
          setPage("library");
        }
      } else {
        setPendingImport({ project: parseProject(data) });
        setPage("library");
      }
      setLibraryRevision((value) => value + 1);
    } catch (error) {
      notify(
        `불러오기 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    e.target.value = "";
  };
  const exportProject = () =>
    download(`${project.name}.json`, JSON.stringify(project, null, 2));
  const exportResult = () => {
    if (result)
      download(
        `${project.name}-result.json`,
        JSON.stringify({ input: project, result }, null, 2),
      );
  };
  const exportCsv = () => {
    if (result)
      download(
        `${project.name}-events.csv`,
        eventsToCsv(result),
        "text/csv;charset=utf-8",
      );
  };
  const cloneScenario = async () => {
    try {
      await flushSave();
      if (!activeScenarioRef.current) {
        await goLibrary(true);
        return;
      }
      await copyScenario({
        id: project.id,
        customerName: project.customerName ?? "",
        name: project.name,
        createdAt: "",
        updatedAt: "",
        lastRunAt: null,
        hasResult: false,
        project: cloneProject(projectRef.current),
        result: null,
      });
    } catch (error) {
      notify(
        `복제 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const undo = () => {
    if (locked || !past.length) return;
    setFuture((f) => [project, ...f]);
    projectRef.current = past[past.length - 1];
    setProject(projectRef.current);
    setLatestResult(null);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (locked || !future.length) return;
    setPast((p) => [...p, project]);
    projectRef.current = future[0];
    setProject(projectRef.current);
    setLatestResult(null);
    setFuture((f) => f.slice(1));
  };
  const selectedNode = project.nodes.find((n) => selected.includes(n.id));
  const selectedObject = project.objects.find((o) => selected.includes(o.id));
  const selectedEdge = project.edges.find((e) => selected.includes(e.id));
  const deleteSelection = () => {
    if (!selected.length) return;
    mutate((p) => {
      const remove = new Set(selected);
      p.nodes = p.nodes.filter((n) => !remove.has(n.id));
      p.edges = p.edges.filter(
        (e) => !remove.has(e.id) && !remove.has(e.from) && !remove.has(e.to),
      );
      p.objects = p.objects.filter((o) => !remove.has(o.id));
    });
    setSelected([]);
    notify("선택 항목을 삭제했습니다. 남은 참조 오류는 검사를 확인하세요.");
  };
  const copySelection = () => {
    const ids: string[] = [];
    mutate((p) => {
      for (const o of project.objects.filter((o) => selected.includes(o.id))) {
        const c = {
          ...o,
          id: nextId(o.kind),
          name: `${o.name} 복사`,
          x: o.x + 1,
          y: o.y + 1,
        };
        p.objects.push(c);
        ids.push(c.id);
      }
      for (const n of project.nodes.filter((n) => selected.includes(n.id))) {
        const c = {
          ...n,
          id: nextId("node"),
          name: `${n.name} 복사`,
          x: n.x + 1,
          y: n.y + 1,
        };
        p.nodes.push(c);
        ids.push(c.id);
      }
    });
    setSelected(ids);
  };
  const alignSelection = (axis: "x" | "y") => {
    const coordinates = [...project.nodes, ...project.objects].filter((o) =>
      selected.includes(o.id),
    );
    if (coordinates.length < 2) return;
    mutate((p) => {
      for (const o of [...p.nodes, ...p.objects])
        if (selected.includes(o.id)) o[axis] = coordinates[0][axis];
    });
  };
  const uploadBackground = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      notify("PNG 또는 JPG 이미지만 지원합니다.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      notify("배경 이미지는 5 MB 이하로 준비해 주세요.");
      return;
    }
    const generation = ++backgroundGeneration.current;
    const reader = new FileReader();
    reader.onerror = () => notify("배경 이미지 파일을 읽지 못했습니다.");
    reader.onload = () => {
      if (generation !== backgroundGeneration.current) return;
      const image = new Image();
      image.onerror = () => notify("배경 이미지를 해석하지 못했습니다.");
      image.onload = () => {
        if (generation !== backgroundGeneration.current) return;
        try {
          mutate((p) => {
            const next = applyDrawingSource(p, {
              name: file.name,
              type: "image",
              page: 1,
              dataUrl: String(reader.result),
              widthPx: image.width,
              heightPx: image.height,
            });
            Object.assign(p, next);
            if (p.spacePlan) p.spacePlan.layout.placements = [];
          });
          setWorkspaceRevision((value) => value + 1);
          notify(
            "배경 도면을 교체했습니다. 이전 축척·공간 확인과 배치 후보를 해제했습니다.",
          );
        } catch (error) {
          notify(
            `배경 입력 실패: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  const filteredEvents =
    result?.events.filter((e) =>
      `${e.kind} ${e.robotId ?? ""} ${e.jobId ?? ""} ${e.resourceId ?? ""} ${e.message}`
        .toLowerCase()
        .includes(eventFilter.toLowerCase()),
    ) ?? [];
  const currentEvents = result
    ? result.events
        .filter((e) =>
          displaySnapshot?.lastEventSequence === undefined
            ? e.time <= (displaySnapshot?.time ?? result.horizon)
            : e.sequence <= displaySnapshot.lastEventSequence,
        )
        .slice(-5)
    : (engineRef.current?.getEvents(5) ?? []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-symbol">
            <span />
            <span />
            <span />
          </span>
          CROIS
          <span className="brand-divider" />
          <small>SIMULATION STUDIO</small>
        </a>
        <div className="project-top">
          <button
            className="scenario-top-home"
            aria-label="고객별 저장함 열기"
            onClick={() => void goLibrary()}
          >
            고객 · 시나리오 <Icon name="arrow" size={13} />
          </button>
          {activeScenarioId && (
            <>
              <span className="breadcrumb">{project.customerName}</span>
              <strong>{project.name}</strong>
            </>
          )}
          {activeScenarioId && (
            <span
              className={`save-state scenario-autosave ${dirty ? "unsaved" : ""}`}
              data-testid="scenario-save-status"
              data-state={saveStatus}
              role="status"
              aria-live="polite"
            >
              <i />
              {saveStatus === "error"
                ? "저장 실패"
                : saveStatus === "saving"
                  ? "자동 저장 중…"
                  : dirty || saveStatus === "pending"
                    ? "저장 대기 중"
                    : "자동 저장됨"}
            </span>
          )}
        </div>
        <div className="top-actions">
          <button
            className="button top-ghost"
            onClick={() => void save()}
            disabled={!activeScenarioId || loading}
          >
            <Icon name="save" />
            저장
          </button>
          <button
            className="button top-ghost"
            onClick={exportProject}
            disabled={!activeScenarioId}
          >
            <Icon name="download" />
            파일 내보내기
          </button>
          <span className="avatar">C</span>
        </div>
      </header>
      <aside className="sidebar">
        <div className="workspace-label">PROJECT WORKSPACE</div>
        <nav aria-label="주요 화면">
          {(
            [
              {
                id: "library",
                icon: "file",
                label: "고객 · 시나리오",
                sub: "Saved scenarios on this PC",
              },
              {
                id: "planning",
                icon: "grid",
                label: "공간 · 랙 사전 설계",
                sub: "Drawing to 3D layout",
              },
              {
                id: "edit",
                icon: "edit",
                label: "공간 · 모델 편집",
                sub: "Layout & configuration",
              },
              {
                id: "monitor",
                icon: "play",
                label: "실행 모니터링",
                sub: "SimPy recorded playback",
              },
              {
                id: "results",
                icon: "chart",
                label: "결과 · 시나리오 비교",
                sub: "Results & insights",
              },
            ] as const
          ).map((x) => (
            <button
              key={x.id}
              className={`nav-item ${page === x.id ? "active" : ""}`}
              disabled={x.id !== "library" && !activeScenarioId}
              onClick={() =>
                x.id === "library" ? void goLibrary() : setPage(x.id)
              }
            >
              <Icon name={x.icon} size={21} />
              <span>
                {x.label}
                <small>{x.sub}</small>
              </span>
              {page === x.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        {activeScenarioId && (
          <div className="sidebar-section">
            <div className="sidebar-heading">
              상세 운영 설정
              <span>{project.nodes.length + project.objects.length}</span>
            </div>
            <button
              onClick={() => {
                setPage("edit");
                setPanel("robots");
              }}
              className="resource-link"
            >
              <Icon name="robot" />
              <span>AMR 로봇</span>
              <b>{project.robots.length}</b>
            </button>
            <button
              onClick={() => {
                setPage("edit");
                setPanel("production");
              }}
              className="resource-link"
            >
              <Icon name="settings" />
              <span>제조 공정</span>
              <b>{project.processes.length}</b>
            </button>
            <button
              onClick={() => {
                setPage("edit");
                setPanel("resources");
              }}
              className="resource-link"
            >
              <Icon name="box" />
              <span>버퍼 · 충전기</span>
              <b>{project.buffers.length + project.chargers.length}</b>
            </button>
            <button
              onClick={() => {
                setPage("edit");
                setPanel("conditions");
              }}
              className="resource-link"
            >
              <Icon name="route" />
              <span>운영 조건</span>
              <b>SI</b>
            </button>
          </div>
        )}
        <div className="sidebar-section">
          <div className="sidebar-heading">프로젝트 관리</div>
          <button
            className="resource-link"
            disabled={loading}
            onClick={newProject}
          >
            <Icon name="plus" />
            <span>새 시나리오 만들기</span>
          </button>
          <button
            className="resource-link"
            disabled={locked}
            onClick={() => importRef.current?.click()}
          >
            <Icon name="upload" />
            <span>프로젝트 / 실행 불러오기</span>
          </button>
          <button
            className="resource-link"
            disabled={!activeScenarioId || playing || loading}
            onClick={() => void cloneScenario()}
          >
            <Icon name="file" />
            <span>대안 시나리오 복제</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="engine-badge">
            <i /> SIMPY DES ENGINE
          </div>
          <strong>
            DES <span>{ENGINE_VERSION}</span>
          </strong>
          <p>
            동일 입력 · 동일 시드
            <br />
            재현 가능한 의사결정
          </p>
          <div className="sidebar-unit">m · s · kg · Wh · W</div>
        </div>
      </aside>
      <main className="main-area">
        {page === "library" ? (
          <UiScenarioLibrary
            revision={libraryRevision}
            pendingImport={pendingImport}
            legacy={legacyProject}
            onCreate={createNamedScenario}
            onOpen={openScenario}
            onCopy={copyScenario}
            onDeleted={(id) => {
              if (activeScenarioRef.current === id) {
                clearRun();
                activeScenarioRef.current = null;
                setActiveScenarioId(null);
                setLatestResult(null);
                setSaveStatus("idle");
              }
              setLibraryRevision((value) => value + 1);
            }}
            onImportLegacy={() => {
              if (legacyProject) setPendingImport({ project: legacyProject });
            }}
            onClearImport={() => setPendingImport(null)}
          />
        ) : (
          <>
            {saveError && (
              <div className="scenario-autosave-error" role="alert">
                <span>자동 저장에 실패했습니다: {saveError}</span>
                <button className="button small" onClick={() => void save()}>
                  저장 다시 시도
                </button>
              </div>
            )}
            <div className="scenario-context-bar">
              <div>
                <strong>{project.customerName}</strong> / {project.name}
                <br />
                <small>
                  입력은 자동 저장됩니다. 도면·사양을 순서대로 바꾸거나 준비된
                  예제로 먼저 계산할 수 있습니다.
                </small>
              </div>
              {latestResult && !result && (
                <button
                  className="button small"
                  onClick={() => {
                    clearRun();
                    setResult(latestResult);
                    setSnapshot(latestResult.finalState);
                    setPage("results");
                  }}
                >
                  최근 저장 결과 보기
                </button>
              )}
            </div>
            <section className="page-heading">
              <div>
                <div className="eyebrow">AMR & MANUFACTURING LOGISTICS</div>
                <h1>
                  {page === "planning"
                    ? "도면에서 공간 설계까지"
                    : page === "edit"
                      ? "공간과 운영을 설계하세요"
                      : page === "monitor"
                        ? "시뮬레이션 기록 모니터링"
                        : "데이터로 확인하는 운영 성과"}
                  <span className="pill">
                    {page === "planning"
                      ? "WEB · 3D"
                      : page === "edit"
                        ? "2D 모델"
                        : page === "monitor"
                          ? loading
                            ? "SimPy 계산 중"
                            : playing
                              ? "재생 중"
                              : snapshot?.finished
                                ? "실행 완료"
                                : snapshot
                                  ? "일시정지"
                                  : "실행 준비"
                          : "분석"}
                  </span>
                </h1>
                <p>
                  {page === "planning"
                    ? "도면·실측 사양을 바탕으로 랙 단수와 장비 인계 높이를 비교하고 배치 후보를 살펴봅니다."
                    : page === "edit"
                      ? "생산라인과 물류 자원을 배치하고, 시나리오에 맞는 운영 조건을 설정합니다."
                      : page === "monitor"
                        ? "SimPy 계산 후 기록 재생 · 배속과 일시정지는 서버 계산 결과에 영향을 주지 않습니다."
                        : "처리량·대기 원인·자원 활용도를 확인하고 대안 시나리오를 비교합니다."}
                </p>
              </div>
              <div className="heading-actions">
                {page === "planning" ? (
                  <button className="button" onClick={() => setPage("edit")}>
                    <Icon name="edit" />
                    2D 시뮬레이터
                  </button>
                ) : (
                  <>
                    {page === "edit" ? (
                      <button
                        className="button"
                        onClick={() => setPanel("conditions")}
                      >
                        <Icon name="settings" />
                        실행 조건
                      </button>
                    ) : (
                      <button
                        className="button"
                        disabled={playing || loading}
                        onClick={() => {
                          clearRun();
                          setPage("edit");
                        }}
                      >
                        <Icon name="edit" />
                        입력 편집
                      </button>
                    )}
                    <button
                      className="button primary"
                      onClick={fastRun}
                      disabled={playing || loading || errors.length > 0}
                    >
                      <Icon name="play" />
                      {loading
                        ? "SimPy 계산 중…"
                        : snapshot?.finished
                          ? "결과 다시 보기"
                          : "전체 계산"}
                    </button>
                  </>
                )}
              </div>
            </section>
            {loading && (
              <div className="info-note" role="status" aria-live="polite">
                <strong>SimPy 서버에서 계산 중입니다…</strong>
                <p>
                  전체 시뮬레이션 결과를 받은 뒤 기록을 재생합니다. 계산 중에는
                  입력이 잠깁니다.
                </p>
                <button className="button small" onClick={clearRun}>
                  계산 요청 취소
                </button>
              </div>
            )}
            {page !== "planning" && (
              <div className="summary-grid">
                <div className="summary-card">
                  <span className="summary-icon teal">
                    <Icon name="robot" size={23} />
                  </span>
                  <div>
                    <small>AMR 운영 대수</small>
                    <strong>
                      {project.robots.length}
                      <em>대</em>
                    </strong>
                  </div>
                  <span className="summary-note">{active}대 작업 중</span>
                </div>
                <div className="summary-card">
                  <span className="summary-icon blue">
                    <Icon name="box" size={23} />
                  </span>
                  <div>
                    <small>
                      {result ? "완료 운송 작업" : "생산 · 운송 연결"}
                    </small>
                    <strong>
                      {result
                        ? number(result.kpis.transportCompleted, 0)
                        : project.transportRules.length}
                      <em>{result ? "건" : "개 규칙"}</em>
                    </strong>
                  </div>
                  <span className="summary-note">
                    유한 버퍼 {project.buffers.length}개
                  </span>
                </div>
                <div className="summary-card">
                  <span className="summary-icon amber">
                    <Icon name="bolt" size={23} />
                  </span>
                  <div>
                    <small>충전 인프라</small>
                    <strong>
                      {project.chargers.reduce((n, c) => n + c.capacity, 0)}
                      <em>포트</em>
                    </strong>
                  </div>
                  <span className="summary-note">
                    {project.chargers.length}개 충전 위치
                  </span>
                </div>
                <div className="summary-card">
                  <span className="summary-icon violet">
                    <Icon name="chart" size={23} />
                  </span>
                  <div>
                    <small>{result ? "생산 처리량" : "분석 시간"}</small>
                    <strong>
                      {result
                        ? number(result.kpis.productionPerHour)
                        : number(project.settings.duration / 60)}
                      <em>{result ? "개/h" : "min"}</em>
                    </strong>
                  </div>
                  <span className="summary-note">
                    Seed {project.settings.seed}
                  </span>
                </div>
              </div>
            )}

            {page === "planning" ? (
              <UiPlanning
                key={workspaceRevision}
                project={project}
                onChange={change}
                disabled={locked}
                onComplete={() => void fastRun()}
              />
            ) : page !== "results" ? (
              <div
                className={`workspace-grid ${page === "monitor" ? "monitor-grid" : ""}`}
              >
                <section className="canvas-card">
                  <div className="card-heading">
                    <div>
                      <h2>
                        <span className="section-indicator" />
                        2D 레이아웃{" "}
                        <span className="subtle">/ {project.name}</span>
                      </h2>
                      <small>
                        {page === "edit"
                          ? "노드를 연결하고 자원의 위치를 구성하세요."
                          : "색상은 로봇 상태와 공유 통로 점유를 나타냅니다."}
                      </small>
                    </div>
                    <div className="canvas-tags">
                      <span className="tiny-pill">
                        {project.nodes.length} NODES
                      </span>
                      <span className="tiny-pill">
                        {project.edges.length} LINKS
                      </span>
                    </div>
                  </div>
                  <div className="map-toolbar">
                    <div className="tool-group">
                      {(
                        [
                          {
                            id: "select",
                            icon: "cursor",
                            label: "선택 (Shift 다중 선택)",
                          },
                          { id: "node", icon: "node", label: "노드 추가" },
                          {
                            id: "edge",
                            icon: "route",
                            label: "연결 추가: 시작·종료 노드 클릭",
                          },
                          {
                            id: "object",
                            icon: "box",
                            label: "배치 객체 추가",
                          },
                        ] as const
                      ).map((t) => (
                        <button
                          title={t.label}
                          aria-label={t.label}
                          key={t.id}
                          className={`icon-button ${tool === t.id ? "selected" : ""}`}
                          onClick={() => setTool(t.id)}
                          disabled={locked || page !== "edit"}
                        >
                          <Icon name={t.icon} />
                        </button>
                      ))}
                    </div>
                    {tool === "object" && (
                      <select
                        aria-label="배치 객체 종류"
                        className="compact-select"
                        value={objectKind}
                        disabled={locked}
                        onChange={(e) =>
                          setObjectKind(e.target.value as MapObject["kind"])
                        }
                      >
                        {Object.entries({
                          rack: "랙",
                          pallet: "팔레트",
                          cart: "대차",
                          line: "제조라인",
                          buffer: "버퍼 표시",
                          wall: "벽",
                          column: "기둥",
                          wait: "대기 위치",
                          charger: "충전기 표시",
                        }).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="tool-divider" />
                    <button
                      className="icon-button"
                      title="실행 취소"
                      aria-label="실행 취소"
                      disabled={locked || !past.length}
                      onClick={undo}
                    >
                      <Icon name="undo" />
                    </button>
                    <button
                      className="icon-button"
                      title="다시 실행"
                      aria-label="다시 실행"
                      disabled={locked || !future.length}
                      onClick={redo}
                    >
                      <Icon name="redo" />
                    </button>
                    <label className="snap-toggle">
                      <input
                        type="checkbox"
                        checked={snap}
                        onChange={(e) => setSnap(e.target.checked)}
                      />
                      격자 맞춤
                    </label>
                    <div className="zoom-control">
                      <button
                        title="축소"
                        onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
                      >
                        −
                      </button>
                      <button
                        title="화면 맞춤"
                        onClick={() => {
                          setZoom(1);
                          setMapRevision((n) => n + 1);
                        }}
                      >
                        {Math.round(zoom * 100)}%
                      </button>
                      <button
                        title="확대"
                        onClick={() => setZoom((z) => Math.min(4, z + 0.2))}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="canvas-stage">
                    <UiMap
                      key={mapRevision}
                      project={project}
                      snapshot={displaySnapshot}
                      editable={!locked && page === "edit"}
                      selected={selected}
                      onSelect={(ids) => {
                        setSelected(ids);
                        setPanel(
                          project.buffers.some((b) => ids.includes(b.id)) ||
                            project.chargers.some((c) => ids.includes(c.id))
                            ? "resources"
                            : project.robots.some((r) => ids.includes(r.id))
                              ? "robots"
                              : "selection",
                        );
                      }}
                      onChange={change}
                      tool={tool}
                      objectKind={objectKind}
                      snap={snap}
                      zoom={zoom}
                      onZoom={setZoom}
                    />
                    <div className="canvas-corner">
                      <span className="map-coordinate">XY / m</span>
                      <span>평면 물류 모델 · 안전 검증용 아님</span>
                    </div>
                  </div>
                  <div className="map-legend">
                    <span>
                      <i style={{ background: "#14b8a6" }} />
                      AMR / 적재 이동
                    </span>
                    <span>
                      <i style={{ background: "#f59e0b" }} />
                      대기 · 정체
                    </span>
                    <span>
                      <i style={{ background: "#22c55e" }} />
                      충전
                    </span>
                    <span>
                      <i className="line-legend" />
                      이동 경로
                    </span>
                    <span className="legend-right">
                      {locked
                        ? "입력 잠금 · 초기화 후 편집"
                        : "드래그 이동 · Shift 다중 선택 · 휠 확대"}
                    </span>
                  </div>
                  <div className="run-controls">
                    <button
                      className={`button ${playing ? "" : "primary"}`}
                      onClick={play}
                      disabled={
                        loading || errors.length > 0 || snapshot?.finished
                      }
                    >
                      <Icon name={playing ? "pause" : "play"} />
                      {loading
                        ? "계산 중…"
                        : playing
                          ? "일시정지"
                          : snapshot
                            ? "계속"
                            : "시작"}
                    </button>
                    <button
                      className="icon-button bordered"
                      title="이벤트 단위 진행"
                      aria-label="이벤트 단위 진행"
                      onClick={step}
                      disabled={
                        playing ||
                        loading ||
                        snapshot?.finished ||
                        errors.length > 0
                      }
                    >
                      <Icon name="step" />
                    </button>
                    <button
                      className="icon-button bordered"
                      title="초기화"
                      aria-label="초기화"
                      onClick={clearRun}
                      disabled={!locked}
                    >
                      <Icon name="reset" />
                    </button>
                    <div className="simulation-clock">
                      <span>SIMULATION TIME</span>
                      <strong>
                        {seconds(displaySnapshot?.time ?? 0)}
                        <small> / {seconds(project.settings.duration)}</small>
                      </strong>
                    </div>
                    <div className="speed-field">
                      <span>재생 배속</span>
                      <select
                        aria-label="재생 배속"
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                      >
                        <option value={1}>1×</option>
                        <option value={10}>10×</option>
                        <option value={20}>20×</option>
                        <option value={100}>100×</option>
                        <option value={500}>500×</option>
                      </select>
                    </div>
                    <div className="event-count">
                      <strong>
                        {number(displaySnapshot?.eventCount ?? 0, 0)}
                      </strong>{" "}
                      EVENTS
                    </div>
                  </div>
                  <div className="progress-track">
                    <div
                      style={{
                        width: `${Math.min(100, ((displaySnapshot?.time ?? 0) / project.settings.duration) * 100)}%`,
                      }}
                    />
                  </div>
                </section>
                <aside className="inspector-card">
                  {page === "edit" ? (
                    <>
                      <div className="inspector-tabs">
                        {(
                          [
                            { id: "selection", name: "속성" },
                            { id: "conditions", name: "조건" },
                            { id: "robots", name: "로봇" },
                            { id: "production", name: "생산" },
                            { id: "resources", name: "자원" },
                            { id: "json", name: "JSON" },
                          ] as const
                        ).map((t) => (
                          <button
                            key={t.id}
                            className={panel === t.id ? "active" : ""}
                            onClick={() => {
                              setPanel(t.id);
                              if (t.id === "json")
                                setJsonDraft(JSON.stringify(project, null, 2));
                            }}
                          >
                            {t.name}
                          </button>
                        ))}
                      </div>
                      <div className="inspector-body">
                        <fieldset disabled={locked}>
                          {panel === "selection" && (
                            <>
                              <div className="inspector-title">
                                <h3>선택 항목 속성</h3>
                                <span className="tiny-pill">
                                  {selected.length} SELECTED
                                </span>
                              </div>
                              {!selected.length ? (
                                <div className="selection-empty">
                                  <span>
                                    <Icon name="cursor" size={30} />
                                  </span>
                                  <h3>편집할 항목을 선택하세요</h3>
                                  <p>
                                    지도에서 노드·경로·배치 객체를 클릭하면
                                    위치와 사양을 설정할 수 있습니다.
                                  </p>
                                  <div className="shortcut">
                                    Shift + 클릭 <span>여러 항목 선택</span>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="selection-actions">
                                    <button
                                      className="button small"
                                      onClick={copySelection}
                                    >
                                      복사
                                    </button>
                                    <button
                                      className="button small"
                                      onClick={() =>
                                        mutate((p) =>
                                          p.objects
                                            .filter((o) =>
                                              selected.includes(o.id),
                                            )
                                            .forEach(
                                              (o) =>
                                                (o.rotation =
                                                  (o.rotation + 90) % 360),
                                            ),
                                        )
                                      }
                                    >
                                      90° 회전
                                    </button>
                                    <button
                                      className="button small danger"
                                      onClick={deleteSelection}
                                    >
                                      삭제
                                    </button>
                                  </div>
                                  {selected.length > 1 && (
                                    <div className="selection-actions">
                                      <button
                                        className="button small"
                                        onClick={() => alignSelection("x")}
                                      >
                                        X 정렬
                                      </button>
                                      <button
                                        className="button small"
                                        onClick={() => alignSelection("y")}
                                      >
                                        Y 정렬
                                      </button>
                                    </div>
                                  )}
                                  {selectedNode && (
                                    <>
                                      <div className="entity-heading">
                                        NODE <code>{selectedNode.id}</code>
                                      </div>
                                      <Field label="노드 이름">
                                        <input
                                          value={selectedNode.name}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.nodes.find(
                                                (n) => n.id === selectedNode.id,
                                              )!.name = e.target.value;
                                            })
                                          }
                                        />
                                      </Field>
                                      <div className="field-grid">
                                        {(["x", "y"] as const).map((k) => (
                                          <Field
                                            key={k}
                                            label={`${k.toUpperCase()} (m)`}
                                          >
                                            <Num
                                              value={selectedNode[k]}
                                              min={-10000}
                                              step={0.5}
                                              onChange={(v) =>
                                                mutate((p) => {
                                                  p.nodes.find(
                                                    (n) =>
                                                      n.id === selectedNode.id,
                                                  )![k] = v;
                                                })
                                              }
                                            />
                                          </Field>
                                        ))}
                                      </div>
                                      <Field label="용도">
                                        <select
                                          value={selectedNode.kind}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.nodes.find(
                                                (n) => n.id === selectedNode.id,
                                              )!.kind = e.target
                                                .value as typeof selectedNode.kind;
                                            })
                                          }
                                        >
                                          {Object.entries({
                                            transit: "통과",
                                            pickup: "상차",
                                            dropoff: "하차",
                                            wait: "대기",
                                            charge: "충전",
                                            intersection: "교차로",
                                          }).map(([k, v]) => (
                                            <option key={k} value={k}>
                                              {v}
                                            </option>
                                          ))}
                                        </select>
                                      </Field>
                                      <Field label="층 ID">
                                        <input
                                          value={selectedNode.floorId ?? "1F"}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.nodes.find(
                                                (n) => n.id === selectedNode.id,
                                              )!.floorId = e.target.value;
                                            })
                                          }
                                        />
                                      </Field>
                                    </>
                                  )}
                                  {selectedObject && (
                                    <>
                                      <div className="entity-heading">
                                        OBJECT <code>{selectedObject.id}</code>
                                      </div>
                                      <Field label="객체 이름">
                                        <input
                                          value={selectedObject.name}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.objects.find(
                                                (o) =>
                                                  o.id === selectedObject.id,
                                              )!.name = e.target.value;
                                            })
                                          }
                                        />
                                      </Field>
                                      <div className="field-grid">
                                        {(
                                          [
                                            "x",
                                            "y",
                                            "width",
                                            "height",
                                            "rotation",
                                          ] as const
                                        ).map((k) => (
                                          <Field
                                            key={k}
                                            label={
                                              {
                                                x: "X (m)",
                                                y: "Y (m)",
                                                width: "가로 (m)",
                                                height: "세로 (m)",
                                                rotation: "회전 (°)",
                                              }[k]
                                            }
                                          >
                                            <Num
                                              value={selectedObject[k]}
                                              step={k === "rotation" ? 15 : 0.5}
                                              min={
                                                k === "x" || k === "y"
                                                  ? -10000
                                                  : 0
                                              }
                                              onChange={(v) =>
                                                mutate((p) => {
                                                  p.objects.find(
                                                    (o) =>
                                                      o.id ===
                                                      selectedObject.id,
                                                  )![k] = v;
                                                })
                                              }
                                            />
                                          </Field>
                                        ))}
                                      </div>
                                      <Field label="접근 노드">
                                        <select
                                          value={selectedObject.nodeId ?? ""}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.objects.find(
                                                (o) =>
                                                  o.id === selectedObject.id,
                                              )!.nodeId =
                                                e.target.value || undefined;
                                            })
                                          }
                                        >
                                          <option value="">없음</option>
                                          {project.nodes.map((n) => (
                                            <option key={n.id} value={n.id}>
                                              {n.name}
                                            </option>
                                          ))}
                                        </select>
                                      </Field>
                                      <p className="info-note">
                                        배치 객체는 평면 표현입니다. 처리
                                        용량·재고·충전 동작은 ‘자원’ 탭에서 같은
                                        접근 노드에 연결하세요.
                                      </p>
                                    </>
                                  )}
                                  {selectedEdge && (
                                    <>
                                      <div className="entity-heading">
                                        LINK <code>{selectedEdge.id}</code>
                                      </div>
                                      <div className="field-grid">
                                        {(
                                          [
                                            "length",
                                            "width",
                                            "speedLimit",
                                          ] as const
                                        ).map((k) => (
                                          <Field
                                            key={k}
                                            label={
                                              {
                                                length: "실제 이동 길이 (m)",
                                                width: "통로 폭 (m)",
                                                speedLimit: "속도 제한 (m/s)",
                                              }[k]
                                            }
                                          >
                                            <Num
                                              value={selectedEdge[k]}
                                              step={0.1}
                                              onChange={(v) =>
                                                mutate((p) => {
                                                  p.edges.find(
                                                    (a) =>
                                                      a.id === selectedEdge.id,
                                                  )![k] = v;
                                                })
                                              }
                                            />
                                          </Field>
                                        ))}
                                      </div>
                                      <Field
                                        label="공유 구역 ID"
                                        hint="같은 물리 통로를 공유하는 연결은 같은 ID를 사용합니다."
                                      >
                                        <input
                                          value={selectedEdge.zoneId ?? ""}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.edges.find(
                                                (a) => a.id === selectedEdge.id,
                                              )!.zoneId =
                                                e.target.value || undefined;
                                            })
                                          }
                                        />
                                      </Field>
                                      <label className="checkbox-field">
                                        <input
                                          type="checkbox"
                                          checked={selectedEdge.bidirectional}
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.edges.find(
                                                (a) => a.id === selectedEdge.id,
                                              )!.bidirectional =
                                                e.target.checked;
                                            })
                                          }
                                        />
                                        양방향 통행
                                      </label>
                                      <label className="checkbox-field">
                                        <input
                                          type="checkbox"
                                          checked={
                                            selectedEdge.disabled ?? false
                                          }
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.edges.find(
                                                (a) => a.id === selectedEdge.id,
                                              )!.disabled = e.target.checked;
                                            })
                                          }
                                        />
                                        통행 금지
                                      </label>
                                      <Field label="허용 로봇 종류 ID (쉼표, 비우면 전체)">
                                        <input
                                          value={
                                            selectedEdge.allowedRobotTypes?.join(
                                              ", ",
                                            ) ?? ""
                                          }
                                          onChange={(e) =>
                                            mutate((p) => {
                                              p.edges.find(
                                                (a) => a.id === selectedEdge.id,
                                              )!.allowedRobotTypes =
                                                e.target.value
                                                  .split(",")
                                                  .map((s) => s.trim())
                                                  .filter(Boolean);
                                            })
                                          }
                                        />
                                      </Field>
                                    </>
                                  )}
                                </>
                              )}
                              <div className="inspector-divider" />
                              <h3>도면 배경</h3>
                              <button
                                className="button full"
                                onClick={() => backgroundRef.current?.click()}
                              >
                                <Icon name="upload" />
                                PNG / JPG 불러오기
                              </button>
                              {project.background && (
                                <>
                                  <div className="field-grid">
                                    {(
                                      [
                                        "x",
                                        "y",
                                        "width",
                                        "height",
                                        "opacity",
                                      ] as const
                                    ).map((k) => (
                                      <Field
                                        key={k}
                                        label={
                                          {
                                            x: "기준점 X (m)",
                                            y: "기준점 Y (m)",
                                            width: "실제 가로 (m)",
                                            height: "실제 세로 (m)",
                                            opacity: "불투명도 (0~1)",
                                          }[k]
                                        }
                                      >
                                        <Num
                                          value={project.background![k]}
                                          min={
                                            k === "x" || k === "y" ? -10000 : 0
                                          }
                                          step={k === "opacity" ? 0.05 : 0.5}
                                          onChange={(v) =>
                                            mutate((p) => {
                                              p.background![k] = v;
                                              if (
                                                p.spacePlan &&
                                                (k === "width" ||
                                                  k === "height")
                                              ) {
                                                p.spacePlan.calibration.confirmed = false;
                                                p.spacePlan.building.confirmed = false;
                                                p.spacePlan.layout.placements =
                                                  [];
                                              }
                                            })
                                          }
                                        />
                                      </Field>
                                    ))}
                                  </div>
                                  <button
                                    className="text-button danger"
                                    onClick={() =>
                                      mutate((p) => {
                                        delete p.background;
                                      })
                                    }
                                  >
                                    배경 제거
                                  </button>
                                </>
                              )}
                            </>
                          )}
                          {panel === "conditions" && (
                            <>
                              <h3>고객 · 시나리오 · 실행 조건</h3>
                              <Field label="고객 이름">
                                <input
                                  value={project.customerName ?? ""}
                                  maxLength={120}
                                  onChange={(event) =>
                                    mutate((p) => {
                                      p.customerName = event.target.value;
                                    })
                                  }
                                />
                              </Field>
                              <Field label="시나리오 이름">
                                <input
                                  value={project.name}
                                  onChange={(e) =>
                                    mutate((p) => {
                                      p.name = e.target.value;
                                    })
                                  }
                                />
                              </Field>
                              <Field label="설명">
                                <textarea
                                  value={project.description}
                                  rows={3}
                                  onChange={(e) =>
                                    mutate((p) => {
                                      p.description = e.target.value;
                                    })
                                  }
                                />
                              </Field>
                              <div className="field-grid">
                                <Field label="종료 시각 (s)">
                                  <Num
                                    value={project.settings.duration}
                                    onChange={(v) =>
                                      mutate((p) => {
                                        p.settings.duration = v;
                                      })
                                    }
                                  />
                                </Field>
                                <Field label="난수 시드">
                                  <Num
                                    value={project.settings.seed}
                                    onChange={(v) =>
                                      mutate((p) => {
                                        p.settings.seed = v;
                                      })
                                    }
                                  />
                                </Field>
                              </div>
                              <Field label="워밍업 제외 구간 (s)">
                                <Num
                                  value={project.settings.warmup}
                                  onChange={(v) =>
                                    mutate((p) => {
                                      p.settings.warmup = v;
                                    })
                                  }
                                />
                              </Field>
                              <Field label="배차 정책">
                                <select
                                  value={project.settings.dispatchPolicy}
                                  onChange={(e) =>
                                    mutate((p) => {
                                      p.settings.dispatchPolicy = e.target
                                        .value as Project["settings"]["dispatchPolicy"];
                                    })
                                  }
                                >
                                  <option value="fifo">FIFO · 요청 순서</option>
                                  <option value="priority">긴급 우선</option>
                                  <option value="nearest">
                                    최근접 적합 로봇
                                  </option>
                                  <option value="earliestFinish">
                                    예상 완료시간
                                  </option>
                                </select>
                              </Field>
                              <p className="info-note">
                                내부 단위는 m · s · kg · Wh · W입니다. 화면
                                배속은 재생 속도만 바꾸며 계산 결과에는 영향을
                                주지 않습니다.
                              </p>
                              <h3>입력 가정</h3>
                              <ul className="assumption-list">
                                {project.assumptions.map((a, i) => (
                                  <li key={i}>{a}</li>
                                ))}
                              </ul>
                            </>
                          )}
                          {panel === "robots" && (
                            <>
                              <div className="inspector-title">
                                <h3>AMR 구성</h3>
                                <button
                                  className="button small"
                                  onClick={() =>
                                    mutate((p) => {
                                      if (!p.robotTypes[0] || !p.nodes[0])
                                        return;
                                      p.robots.push({
                                        id: nextId("robot"),
                                        name: `AMR ${p.robots.length + 1}`,
                                        typeId: p.robotTypes[0].id,
                                        nodeId: p.nodes[0].id,
                                        initialBatteryWh:
                                          p.robotTypes[0].batteryCapacityWh,
                                      });
                                    })
                                  }
                                >
                                  <Icon name="plus" size={14} />
                                  추가
                                </button>
                              </div>
                              {project.robots.map((r) => (
                                <details
                                  className="entity-card"
                                  key={r.id}
                                  open={project.robots.length < 4}
                                >
                                  <summary>
                                    <Icon name="robot" size={16} />
                                    {r.name}
                                    <code>{r.typeId}</code>
                                  </summary>
                                  <Field label="이름">
                                    <input
                                      value={r.name}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.robots.find(
                                            (x) => x.id === r.id,
                                          )!.name = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field label="로봇 종류">
                                    <select
                                      value={r.typeId}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.robots.find(
                                            (x) => x.id === r.id,
                                          )!.typeId = e.target.value;
                                        })
                                      }
                                    >
                                      {project.robotTypes.map((t) => (
                                        <option value={t.id} key={t.id}>
                                          {t.name}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <Field label="초기 위치">
                                    <select
                                      value={r.nodeId}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.robots.find(
                                            (x) => x.id === r.id,
                                          )!.nodeId = e.target.value;
                                        })
                                      }
                                    >
                                      {project.nodes.map((n) => (
                                        <option value={n.id} key={n.id}>
                                          {n.name}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <Field label="초기 에너지 (Wh)">
                                    <Num
                                      value={r.initialBatteryWh}
                                      onChange={(v) =>
                                        mutate((p) => {
                                          p.robots.find(
                                            (x) => x.id === r.id,
                                          )!.initialBatteryWh = v;
                                        })
                                      }
                                    />
                                  </Field>
                                  <button
                                    className="text-button danger"
                                    onClick={() =>
                                      mutate((p) => {
                                        p.robots = p.robots.filter(
                                          (x) => x.id !== r.id,
                                        );
                                      })
                                    }
                                  >
                                    로봇 제거
                                  </button>
                                </details>
                              ))}
                              <div className="inspector-divider" />
                              <div className="inspector-title">
                                <h3>로봇 사양 템플릿</h3>
                                <button
                                  className="button small"
                                  disabled={!project.robotTypes[0]}
                                  onClick={() =>
                                    mutate((p) => {
                                      const t = p.robotTypes[0];
                                      p.robotTypes.push({
                                        ...t,
                                        id: nextId("type"),
                                        name: `${t.name} 복사`,
                                      });
                                    })
                                  }
                                >
                                  복제
                                </button>
                              </div>
                              {project.robotTypes.map((t) => (
                                <details className="entity-card" key={t.id}>
                                  <summary>
                                    {t.name}
                                    <code>{t.id}</code>
                                  </summary>
                                  <Field label="템플릿 이름">
                                    <input
                                      value={t.name}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.robotTypes.find(
                                            (x) => x.id === t.id,
                                          )!.name = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <div className="field-grid">
                                    {(
                                      Object.entries({
                                        width: "차체 폭 (m)",
                                        length: "차체 길이 (m)",
                                        maxPayloadKg: "적재 중량 (kg)",
                                        maxUnits: "적재 수량",
                                        emptySpeed: "공차 속도 (m/s)",
                                        loadedSpeed: "적재 속도 (m/s)",
                                        acceleration: "가감속 (m/s²)",
                                        turnTime: "회전 시간 (s)",
                                        loadTime: "적재 시간 (s)",
                                        unloadTime: "하역 시간 (s)",
                                        batteryCapacityWh: "배터리 용량 (Wh)",
                                        idlePowerW: "대기 소모 (W)",
                                        emptyPowerW: "공차 소모 (W)",
                                        loadedPowerW: "적재 소모 (W)",
                                        reserveWh: "예비 잔량 (Wh)",
                                        chargeBelowWh: "충전 시작 (Wh)",
                                        chargeToWh: "충전 종료 (Wh)",
                                      }) as Array<[keyof typeof t, string]>
                                    ).map(([k, l]) => (
                                      <Field label={l} key={k}>
                                        <Num
                                          value={t[k] as number}
                                          step={0.1}
                                          onChange={(v) =>
                                            mutate((p) => {
                                              (
                                                p.robotTypes.find(
                                                  (x) => x.id === t.id,
                                                )! as unknown as Record<
                                                  string,
                                                  unknown
                                                >
                                              )[k] = v;
                                            })
                                          }
                                        />
                                      </Field>
                                    ))}
                                  </div>
                                  <Field label="지원 운송물 (쉼표 구분)">
                                    <input
                                      value={t.cargoTypes.join(", ")}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.robotTypes.find(
                                            (x) => x.id === t.id,
                                          )!.cargoTypes = e.target.value
                                            .split(",")
                                            .map((s) => s.trim())
                                            .filter(Boolean);
                                        })
                                      }
                                    />
                                  </Field>
                                </details>
                              ))}
                            </>
                          )}
                          {panel === "production" && (
                            <>
                              <div className="inspector-title">
                                <h3>제조 공정</h3>
                                <button
                                  className="button small"
                                  disabled={!project.buffers[0]}
                                  onClick={() =>
                                    mutate((p) => {
                                      p.processes.push({
                                        id: nextId("process"),
                                        name: "새 생산 공정",
                                        nodeId: p.buffers[0].nodeId,
                                        inputRequirements: {},
                                        outputBufferId: p.buffers[0].id,
                                        outputProduct: "product",
                                        outputQuantity: 1,
                                        processingTime: {
                                          kind: "fixed",
                                          value: 30,
                                        },
                                        isFinal: false,
                                      });
                                    })
                                  }
                                >
                                  추가
                                </button>
                              </div>
                              {project.processes.map((pr) => (
                                <details className="entity-card" key={pr.id}>
                                  <summary>
                                    <Icon name="settings" size={16} />
                                    {pr.name}
                                    <span>{pr.outputProduct}</span>
                                  </summary>
                                  <Field label="공정 이름">
                                    <input
                                      value={pr.name}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.processes.find(
                                            (x) => x.id === pr.id,
                                          )!.name = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field label="출력 버퍼">
                                    <select
                                      value={pr.outputBufferId}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.processes.find(
                                            (x) => x.id === pr.id,
                                          )!.outputBufferId = e.target.value;
                                        })
                                      }
                                    >
                                      {project.buffers.map((b) => (
                                        <option key={b.id} value={b.id}>
                                          {b.name}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <Field label="입력 버퍼">
                                    <select
                                      value={pr.inputBufferId ?? ""}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.processes.find(
                                            (x) => x.id === pr.id,
                                          )!.inputBufferId =
                                            e.target.value || undefined;
                                        })
                                      }
                                    >
                                      <option value="">없음 · 공급 공정</option>
                                      {project.buffers.map((b) => (
                                        <option key={b.id} value={b.id}>
                                          {b.name}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <Field
                                    label="필요 부품 수량 JSON"
                                    hint='예: {"A":2,"B":1}. 편집 후 포커스를 이동하면 적용됩니다.'
                                  >
                                    <JsonInput
                                      value={pr.inputRequirements}
                                      onApply={(v) =>
                                        mutate((p) => {
                                          p.processes.find(
                                            (x) => x.id === pr.id,
                                          )!.inputRequirements = v as Record<
                                            string,
                                            number
                                          >;
                                        })
                                      }
                                    />
                                  </Field>
                                  <div className="field-grid">
                                    <Field label="출력 품종">
                                      <input
                                        value={pr.outputProduct}
                                        onChange={(e) =>
                                          mutate((p) => {
                                            p.processes.find(
                                              (x) => x.id === pr.id,
                                            )!.outputProduct = e.target.value;
                                          })
                                        }
                                      />
                                    </Field>
                                    <Field label="출력 수량">
                                      <Num
                                        value={pr.outputQuantity}
                                        onChange={(v) =>
                                          mutate((p) => {
                                            p.processes.find(
                                              (x) => x.id === pr.id,
                                            )!.outputQuantity = v;
                                          })
                                        }
                                      />
                                    </Field>
                                  </div>
                                  <DistributionEditor
                                    value={pr.processingTime}
                                    onChange={(d) =>
                                      mutate((p) => {
                                        p.processes.find(
                                          (x) => x.id === pr.id,
                                        )!.processingTime = d;
                                      })
                                    }
                                  />
                                  <label className="checkbox-field">
                                    <input
                                      type="checkbox"
                                      checked={pr.isFinal}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.processes.find(
                                            (x) => x.id === pr.id,
                                          )!.isFinal = e.target.checked;
                                        })
                                      }
                                    />
                                    완제품 생산량 KPI에 포함
                                  </label>
                                  <button
                                    className="text-button danger"
                                    onClick={() =>
                                      mutate((p) => {
                                        p.processes = p.processes.filter(
                                          (x) => x.id !== pr.id,
                                        );
                                      })
                                    }
                                  >
                                    공정 제거
                                  </button>
                                </details>
                              ))}
                              <div className="inspector-title">
                                <h3>자동 운송 요청</h3>
                                <button
                                  className="button small"
                                  disabled={project.buffers.length < 2}
                                  onClick={() =>
                                    mutate((p) => {
                                      p.transportRules.push({
                                        id: nextId("rule"),
                                        name: "새 운송 규칙",
                                        sourceBufferId: p.buffers[0].id,
                                        destinationBufferId: p.buffers[1].id,
                                        product:
                                          p.processes[0]?.outputProduct ??
                                          "product",
                                        quantity: 1,
                                        unitWeightKg: 10,
                                        priority: 0,
                                      });
                                    })
                                  }
                                >
                                  추가
                                </button>
                              </div>
                              {project.transportRules.map((r) => (
                                <details className="entity-card" key={r.id}>
                                  <summary>
                                    {r.name}
                                    <span>
                                      {r.product} × {r.quantity}
                                    </span>
                                  </summary>
                                  <Field label="요청 이름">
                                    <input
                                      value={r.name}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.transportRules.find(
                                            (x) => x.id === r.id,
                                          )!.name = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  {(
                                    [
                                      "sourceBufferId",
                                      "destinationBufferId",
                                    ] as const
                                  ).map((k) => (
                                    <Field
                                      key={k}
                                      label={
                                        k === "sourceBufferId"
                                          ? "출발 버퍼"
                                          : "도착 버퍼"
                                      }
                                    >
                                      <select
                                        value={r[k]}
                                        onChange={(e) =>
                                          mutate((p) => {
                                            p.transportRules.find(
                                              (x) => x.id === r.id,
                                            )![k] = e.target.value;
                                          })
                                        }
                                      >
                                        {project.buffers.map((b) => (
                                          <option value={b.id} key={b.id}>
                                            {b.name}
                                          </option>
                                        ))}
                                      </select>
                                    </Field>
                                  ))}
                                  <Field label="운송물 품종">
                                    <input
                                      value={r.product}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.transportRules.find(
                                            (x) => x.id === r.id,
                                          )!.product = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <div className="field-grid">
                                    {(
                                      [
                                        "quantity",
                                        "unitWeightKg",
                                        "priority",
                                        "dueAfter",
                                      ] as const
                                    ).map((k) => (
                                      <Field
                                        key={k}
                                        label={
                                          {
                                            quantity: "운송 수량",
                                            unitWeightKg: "개당 중량 (kg)",
                                            priority: "우선순위",
                                            dueAfter: "요청 후 기한 (s)",
                                          }[k]
                                        }
                                      >
                                        <Num
                                          value={r[k] ?? 0}
                                          onChange={(v) =>
                                            mutate((p) => {
                                              const rule =
                                                p.transportRules.find(
                                                  (x) => x.id === r.id,
                                                )!;
                                              if (k === "dueAfter")
                                                rule.dueAfter =
                                                  v === 0 ? undefined : v;
                                              else rule[k] = v;
                                            })
                                          }
                                        />
                                      </Field>
                                    ))}
                                  </div>
                                  <button
                                    className="text-button danger"
                                    onClick={() =>
                                      mutate((p) => {
                                        p.transportRules =
                                          p.transportRules.filter(
                                            (x) => x.id !== r.id,
                                          );
                                      })
                                    }
                                  >
                                    규칙 제거
                                  </button>
                                </details>
                              ))}
                            </>
                          )}
                          {panel === "resources" && (
                            <>
                              <div className="inspector-title">
                                <h3>유한 버퍼 · 재고</h3>
                                <button
                                  className="button small"
                                  disabled={!project.nodes.length}
                                  onClick={() =>
                                    mutate((p) => {
                                      p.buffers.push({
                                        id: nextId("buffer"),
                                        name: "새 버퍼",
                                        nodeId: p.nodes[0].id,
                                        capacity: 10,
                                        initialInventory: {},
                                      });
                                    })
                                  }
                                >
                                  추가
                                </button>
                              </div>
                              {project.buffers.map((b) => (
                                <details className="entity-card" key={b.id}>
                                  <summary>
                                    <Icon name="box" size={16} />
                                    {b.name}
                                    <span>{b.capacity} slots</span>
                                  </summary>
                                  <Field label="이름">
                                    <input
                                      value={b.name}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.buffers.find(
                                            (x) => x.id === b.id,
                                          )!.name = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field label="접근 노드">
                                    <select
                                      value={b.nodeId}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.buffers.find(
                                            (x) => x.id === b.id,
                                          )!.nodeId = e.target.value;
                                        })
                                      }
                                    >
                                      {project.nodes.map((n) => (
                                        <option key={n.id} value={n.id}>
                                          {n.name}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <Field label="총 수용 수량">
                                    <Num
                                      value={b.capacity}
                                      onChange={(v) =>
                                        mutate((p) => {
                                          p.buffers.find(
                                            (x) => x.id === b.id,
                                          )!.capacity = v;
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field
                                    label="초기 재고 JSON"
                                    hint='예: {"A":10,"B":5}'
                                  >
                                    <JsonInput
                                      value={b.initialInventory}
                                      onApply={(v) =>
                                        mutate((p) => {
                                          p.buffers.find(
                                            (x) => x.id === b.id,
                                          )!.initialInventory = v as Record<
                                            string,
                                            number
                                          >;
                                        })
                                      }
                                    />
                                  </Field>
                                  <button
                                    className="text-button danger"
                                    onClick={() =>
                                      mutate((p) => {
                                        p.buffers = p.buffers.filter(
                                          (x) => x.id !== b.id,
                                        );
                                      })
                                    }
                                  >
                                    버퍼 제거
                                  </button>
                                </details>
                              ))}
                              <div className="inspector-title">
                                <h3>충전 인프라</h3>
                                <button
                                  className="button small"
                                  disabled={!project.nodes.length}
                                  onClick={() =>
                                    mutate((p) => {
                                      p.chargers.push({
                                        id: nextId("charger"),
                                        name: "새 충전기",
                                        nodeId: p.nodes[0].id,
                                        capacity: 1,
                                        waitingCapacity: 2,
                                        powerW: 1000,
                                        compatibleTypes: p.robotTypes.map(
                                          (t) => t.id,
                                        ),
                                        dockTime: 5,
                                        undockTime: 5,
                                      });
                                    })
                                  }
                                >
                                  추가
                                </button>
                              </div>
                              {project.chargers.map((c) => (
                                <details className="entity-card" key={c.id}>
                                  <summary>
                                    <Icon name="bolt" size={16} />
                                    {c.name}
                                    <span>{c.capacity} ports</span>
                                  </summary>
                                  <Field label="이름">
                                    <input
                                      value={c.name}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.chargers.find(
                                            (x) => x.id === c.id,
                                          )!.name = e.target.value;
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field label="접속 노드">
                                    <select
                                      value={c.nodeId}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.chargers.find(
                                            (x) => x.id === c.id,
                                          )!.nodeId = e.target.value;
                                        })
                                      }
                                    >
                                      {project.nodes.map((n) => (
                                        <option key={n.id} value={n.id}>
                                          {n.name}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <div className="field-grid">
                                    {(
                                      [
                                        "capacity",
                                        "waitingCapacity",
                                        "powerW",
                                        "dockTime",
                                        "undockTime",
                                      ] as const
                                    ).map((k) => (
                                      <Field
                                        label={
                                          {
                                            capacity: "동시 충전 대수",
                                            waitingCapacity: "대기 공간 대수",
                                            powerW: "충전 출력 (W)",
                                            dockTime: "도킹 시간 (s)",
                                            undockTime: "이탈 시간 (s)",
                                          }[k]
                                        }
                                        key={k}
                                      >
                                        <Num
                                          value={c[k]}
                                          onChange={(v) =>
                                            mutate((p) => {
                                              p.chargers.find(
                                                (x) => x.id === c.id,
                                              )![k] = v;
                                            })
                                          }
                                        />
                                      </Field>
                                    ))}
                                  </div>
                                  <Field label="호환 로봇 종류 ID (쉼표)">
                                    <input
                                      value={c.compatibleTypes.join(", ")}
                                      onChange={(e) =>
                                        mutate((p) => {
                                          p.chargers.find(
                                            (x) => x.id === c.id,
                                          )!.compatibleTypes = e.target.value
                                            .split(",")
                                            .map((s) => s.trim())
                                            .filter(Boolean);
                                        })
                                      }
                                    />
                                  </Field>
                                  <button
                                    className="text-button danger"
                                    onClick={() =>
                                      mutate((p) => {
                                        p.chargers = p.chargers.filter(
                                          (x) => x.id !== c.id,
                                        );
                                      })
                                    }
                                  >
                                    충전기 제거
                                  </button>
                                </details>
                              ))}
                            </>
                          )}
                          {panel === "json" && (
                            <>
                              <h3>고급 프로젝트 편집</h3>
                              <p className="muted">
                                공유 작업자·설비, 장애 일정 등 전체 스키마를
                                편집할 수 있습니다. 적용 시 버전·참조·단위
                                범위를 검사합니다.
                              </p>
                              <textarea
                                className="json-editor"
                                aria-label="프로젝트 JSON"
                                value={jsonDraft}
                                onChange={(e) => setJsonDraft(e.target.value)}
                                spellCheck={false}
                              />
                              <button
                                className="button primary full"
                                onClick={() => {
                                  try {
                                    change(parseProject(JSON.parse(jsonDraft)));
                                    notify("JSON 입력을 적용했습니다.");
                                  } catch (e) {
                                    notify(`적용 실패: ${String(e)}`);
                                  }
                                }}
                              >
                                검사 후 적용
                              </button>
                            </>
                          )}
                        </fieldset>
                        {locked && (
                          <p className="info-note">
                            실행 입력이 잠겨 있습니다. 초기화하면 편집할 수
                            있습니다.
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="card-heading">
                        <h2>실시간 자원 상태</h2>
                        <span className="live-dot">
                          {playing ? "PLAYBACK" : "PAUSED"}
                        </span>
                      </div>
                      <div className="inspector-body">
                        <div className="monitor-section-title">
                          AMR FLEET <span>{project.robots.length} ROBOTS</span>
                        </div>
                        {(displaySnapshot?.robots ?? []).map((r) => {
                          const spec = project.robots.find(
                            (s) => s.id === r.id,
                          );
                          const type = project.robotTypes.find(
                            (t) => t.id === spec?.typeId,
                          );
                          const percent = type
                            ? (r.batteryWh / type.batteryCapacityWh) * 100
                            : 0;
                          return (
                            <button
                              key={r.id}
                              className={`robot-live ${selected.includes(r.id) ? "selected" : ""}`}
                              onClick={() => setSelected([r.id])}
                            >
                              <span
                                className="robot-live-icon"
                                style={{ color: statusColors[r.status] }}
                              >
                                <Icon name="robot" size={22} />
                              </span>
                              <div>
                                <strong>{spec?.name ?? r.id}</strong>
                                <span style={{ color: statusColors[r.status] }}>
                                  {statusNames[r.status]}
                                </span>
                                <div className="battery-track">
                                  <i
                                    style={{
                                      width: `${Math.max(0, Math.min(100, percent))}%`,
                                      background:
                                        percent < 25 ? "#f59e0b" : "#14b8a6",
                                    }}
                                  />
                                </div>
                              </div>
                              <b>
                                {number(percent, 0)}
                                <small>%</small>
                              </b>
                            </button>
                          );
                        })}
                        {!displaySnapshot && (
                          <p className="muted">
                            시작 또는 이벤트 진행을 누르면 로봇 상태가
                            표시됩니다.
                          </p>
                        )}
                        <div className="monitor-section-title">
                          BUFFER OCCUPANCY
                        </div>
                        {project.buffers.map((b) => {
                          const state = displaySnapshot?.buffers.find(
                            (s) => s.id === b.id,
                          );
                          const count = Object.values(
                            state?.inventory ?? b.initialInventory,
                          ).reduce((a, n) => a + n, 0);
                          return (
                            <div className="buffer-live" key={b.id}>
                              <div>
                                <strong>{b.name}</strong>
                                <span>
                                  {count} / {b.capacity}
                                </span>
                              </div>
                              <div className="buffer-track">
                                <i
                                  style={{
                                    width: `${(count / b.capacity) * 100}%`,
                                    background:
                                      count >= b.capacity
                                        ? "#f59e0b"
                                        : "#38bdf8",
                                  }}
                                />
                              </div>
                              <small>
                                입고 예약 {state?.reservedIn ?? 0} ·{" "}
                                {Object.entries(
                                  state?.inventory ?? b.initialInventory,
                                )
                                  .map(([k, v]) => `${k}: ${v}`)
                                  .join(" / ") || "재고 없음"}
                              </small>
                            </div>
                          );
                        })}
                        <div className="monitor-section-title">
                          CHARGING STATIONS
                        </div>
                        {project.chargers.map((c) => {
                          const s = displaySnapshot?.chargers.find(
                            (x) => x.id === c.id,
                          );
                          return (
                            <div key={c.id} className="charger-live">
                              <Icon name="bolt" />
                              <div>
                                <strong>{c.name}</strong>
                                <small>
                                  점유 {s?.occupants.length ?? 0}/{c.capacity} ·
                                  대기 {s?.queue.length ?? 0}/
                                  {c.waitingCapacity}
                                </small>
                              </div>
                              <span className="tiny-pill">
                                {s?.failed
                                  ? "고장"
                                  : s?.occupants.length
                                    ? "충전 중"
                                    : "가용"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </aside>
              </div>
            ) : (
              <>
                {!result ? (
                  <div className="empty-result">
                    <span>
                      <Icon name="chart" size={46} />
                    </span>
                    <h2>실행 결과가 아직 없습니다</h2>
                    <p>
                      현재 시나리오를 계산하면 처리량과 대기 원인을 확인할 수
                      있습니다.
                    </p>
                    <button
                      className="button primary"
                      onClick={fastRun}
                      disabled={loading || errors.length > 0}
                    >
                      <Icon name="play" />
                      현재 시나리오 전체 계산
                    </button>
                  </div>
                ) : (
                  <>
                    <section className="result-bar">
                      <div>
                        <span className="live-dot">COMPLETED</span>
                        <strong>{project.name}</strong>
                        <small>
                          Seed {result.seed} · Engine {result.engineVersion} ·{" "}
                          {number(result.measurementStart)}–
                          {number(result.horizon)} s 측정
                        </small>
                      </div>
                      <div className="button-row">
                        <button
                          className="button"
                          onClick={() => {
                            setComparisons((cs) => [
                              ...cs.slice(-5),
                              {
                                label: `${project.name} · ${comparisons.length + 1}`,
                                result,
                              },
                            ]);
                            notify("비교 목록에 현재 결과를 보관했습니다.");
                          }}
                        >
                          <Icon name="plus" />
                          비교에 추가
                        </button>
                        <button className="button" onClick={exportCsv}>
                          이벤트 CSV
                        </button>
                        <button
                          className="button primary"
                          onClick={exportResult}
                        >
                          <Icon name="download" />
                          결과 JSON
                        </button>
                      </div>
                    </section>
                    <div className="result-metrics">
                      {[
                        {
                          label: "생산 완료",
                          value: number(result.kpis.productionCompleted, 0),
                          unit: "개",
                          note: `${number(result.kpis.productionPerHour)} 개/h`,
                        },
                        {
                          label: "운송 완료",
                          value: number(result.kpis.transportCompleted, 0),
                          unit: "건",
                          note: `${number(result.kpis.transportPerHour)} 건/h`,
                        },
                        {
                          label: "평균 운송 리드타임",
                          value: number(result.kpis.meanLeadTime),
                          unit: "s",
                          note: "요청부터 하역 완료까지",
                        },
                        {
                          label: "P95 운송 리드타임",
                          value: number(result.kpis.p95LeadTime),
                          unit: "s",
                          note: "완료 작업의 95백분위",
                        },
                        {
                          label: "평균 배차 대기",
                          value: number(result.kpis.meanDispatchWait),
                          unit: "s",
                          note: `미완료 ${result.kpis.unfinishedJobs}건`,
                        },
                        {
                          label: "공차 거리 비율",
                          value: number(result.kpis.emptyDistanceRatio * 100),
                          unit: "%",
                          note: "공차 / 전체 이동 거리",
                        },
                      ].map((m) => (
                        <div className="result-metric" key={m.label}>
                          <span>{m.label}</span>
                          <strong>
                            {m.value}
                            <small>{m.unit}</small>
                          </strong>
                          <p>{m.note}</p>
                        </div>
                      ))}
                    </div>
                    <div className="analysis-grid">
                      <section className="analysis-card">
                        <div className="card-heading">
                          <div>
                            <h2>로봇 상태별 시간</h2>
                            <small>
                              측정 구간 {number(result.kpis.measurementSeconds)}
                              초 · 각 로봇 시간 기준
                            </small>
                          </div>
                          <Icon name="robot" />
                        </div>
                        <div className="analysis-body">
                          {Object.entries(result.kpis.robotStateSeconds).map(
                            ([id, times]) => (
                              <div className="utilization-row" key={id}>
                                <div>
                                  <strong>
                                    {project.robots.find((r) => r.id === id)
                                      ?.name ?? id}
                                  </strong>
                                  <span>
                                    {number(
                                      Object.values(times).reduce(
                                        (a, n) => a + (n ?? 0),
                                        0,
                                      ),
                                    )}{" "}
                                    s
                                  </span>
                                </div>
                                <div className="stacked-bar">
                                  {Object.entries(times)
                                    .filter(([, t]) => t && t > 0)
                                    .map(([status, t]) => (
                                      <span
                                        key={status}
                                        title={`${statusNames[status as RobotStatus]}: ${number(t)} s`}
                                        style={{
                                          width: `${((t ?? 0) / result.kpis.measurementSeconds) * 100}%`,
                                          background:
                                            statusColors[status as RobotStatus],
                                        }}
                                      />
                                    ))}
                                </div>
                              </div>
                            ),
                          )}
                          <div className="state-legend">
                            {Object.entries(statusNames).map(([s, n]) => (
                              <span key={s}>
                                <i
                                  style={{
                                    background: statusColors[s as RobotStatus],
                                  }}
                                />
                                {n}
                              </span>
                            ))}
                          </div>
                        </div>
                      </section>
                      <section className="analysis-card">
                        <div className="card-heading">
                          <div>
                            <h2>공정 대기 · 병목</h2>
                            <small>
                              원인을 선택하면 관련 이벤트를 확인합니다.
                            </small>
                          </div>
                          <Icon name="settings" />
                        </div>
                        <div className="analysis-body">
                          {Object.entries(result.kpis.processStateSeconds).map(
                            ([id, ts]) => (
                              <div className="process-result" key={id}>
                                <strong>
                                  {project.processes.find((p) => p.id === id)
                                    ?.name ?? id}
                                </strong>
                                <div>
                                  {Object.entries(ts).map(([state, t]) => (
                                    <button
                                      key={state}
                                      onClick={() => setEventFilter(id)}
                                    >
                                      <span>
                                        {{
                                          materialWait: "부품 부족",
                                          outputWait: "버퍼 포화",
                                          processing: "가공",
                                          idle: "대기",
                                          equipmentWait: "설비 대기",
                                          failed: "고장",
                                        }[state] ?? state}
                                      </span>
                                      <b>{number(t)} s</b>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      </section>
                      <section className="analysis-card">
                        <div className="card-heading">
                          <h2>충전기 · 버퍼 이용률</h2>
                          <Icon name="bolt" />
                        </div>
                        <div className="analysis-body">
                          {Object.entries(result.kpis.chargerUtilization).map(
                            ([id, n]) => (
                              <div className="buffer-live" key={id}>
                                <div>
                                  <strong>
                                    {project.chargers.find((c) => c.id === id)
                                      ?.name ?? id}
                                  </strong>
                                  <span>{number(n * 100)}%</span>
                                </div>
                                <div className="buffer-track">
                                  <i
                                    style={{
                                      width: `${n * 100}%`,
                                      background: "#22c55e",
                                    }}
                                  />
                                </div>
                              </div>
                            ),
                          )}
                          {Object.entries(result.kpis.bufferOccupancy).map(
                            ([id, n]) => (
                              <div className="buffer-live" key={id}>
                                <div>
                                  <strong>
                                    {project.buffers.find((c) => c.id === id)
                                      ?.name ?? id}
                                  </strong>
                                  <span>{number(n * 100)}%</span>
                                </div>
                                <div className="buffer-track">
                                  <i
                                    style={{
                                      width: `${n * 100}%`,
                                      background: "#38bdf8",
                                    }}
                                  />
                                </div>
                              </div>
                            ),
                          )}
                          <p className="muted">
                            충전: 점유 시간 / (포트 수 × 측정 시간). 버퍼: 시간
                            가중 재고 / (용량 × 측정 시간).
                          </p>
                          <div className="mini-stat">
                            <span>최대 충전 대기열</span>
                            <strong>{result.kpis.maxChargeQueue} 대</strong>
                          </div>
                          <div className="mini-stat">
                            <span>기한 초과 운송</span>
                            <strong>{result.kpis.overdueJobs} 건</strong>
                          </div>
                        </div>
                      </section>
                      <section className="analysis-card">
                        <div className="card-heading">
                          <div>
                            <h2>기록 기반 재생</h2>
                            <small>
                              저장된 상태를 표시하며 새 난수나 계산을 만들지
                              않습니다.
                            </small>
                          </div>
                          <Icon name="step" />
                        </div>
                        <div className="analysis-body">
                          <div className="replay-clock">
                            {seconds(displaySnapshot?.time ?? result.horizon)}
                            <small>{result.history.length}개 기록 상태</small>
                          </div>
                          <input
                            className="replay-range"
                            aria-label="기록 기반 재생 위치"
                            type="range"
                            min={0}
                            max={Math.max(0, result.history.length - 1)}
                            value={
                              replayIndex ??
                              Math.max(0, result.history.length - 1)
                            }
                            onChange={(e) =>
                              setReplayIndex(Number(e.target.value))
                            }
                          />
                          <div className="button-row">
                            <button
                              className="button small"
                              onClick={() => {
                                setReplayIndex(0);
                                setPage("monitor");
                              }}
                            >
                              처음 상태 보기
                            </button>
                            <button
                              className="button small"
                              onClick={() => setPage("monitor")}
                            >
                              지도에서 보기
                            </button>
                            <button
                              className="button small"
                              onClick={() => setReplayIndex(null)}
                            >
                              최종 상태
                            </button>
                          </div>
                          <p className="info-note">
                            재생은 이벤트 직후의 기록 상태를 사용합니다. 동일
                            입력의 재실행은 ‘초기화’ 후 시작하세요.
                          </p>
                        </div>
                      </section>
                    </div>
                    <section className="analysis-card comparison-card">
                      <div className="card-heading">
                        <div>
                          <h2>시나리오 비교</h2>
                          <small>
                            결과를 보관한 뒤 대안을 복제해 로봇·충전기·운영
                            조건을 바꾸세요.
                          </small>
                        </div>
                        <button
                          className="button small"
                          onClick={cloneScenario}
                        >
                          대안 복제
                        </button>
                      </div>
                      {comparisons.length ? (
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>시나리오</th>
                                <th>시드</th>
                                <th>생산 /h</th>
                                <th>운송 완료</th>
                                <th>평균 리드타임</th>
                                <th>P95</th>
                                <th>미완료</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {comparisons.map((c, i) => (
                                <tr key={i}>
                                  <td>
                                    <strong>{c.label}</strong>
                                  </td>
                                  <td>{c.result.seed}</td>
                                  <td>
                                    {number(c.result.kpis.productionPerHour)}
                                  </td>
                                  <td>{c.result.kpis.transportCompleted}</td>
                                  <td>
                                    {number(c.result.kpis.meanLeadTime)} s
                                  </td>
                                  <td>{number(c.result.kpis.p95LeadTime)} s</td>
                                  <td>{c.result.kpis.unfinishedJobs}</td>
                                  <td>
                                    <button
                                      className="text-button danger"
                                      onClick={() =>
                                        setComparisons((cs) =>
                                          cs.filter((_, j) => j !== i),
                                        )
                                      }
                                    >
                                      제거
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="comparison-empty">
                          ‘비교에 추가’로 현재 결과를 보관하세요. 이 목록은 현재
                          세션에만 유지됩니다.
                        </p>
                      )}
                    </section>
                    <section className="analysis-card">
                      <div className="card-heading">
                        <div>
                          <h2>이벤트 추적</h2>
                          <small>
                            실행 ID {result.runId} ·{" "}
                            {number(result.events.length, 0)}건 · 최근 200건
                            표시
                          </small>
                        </div>
                        <label className="event-search">
                          <Icon name="search" size={16} />
                          <input
                            value={eventFilter}
                            onChange={(e) => setEventFilter(e.target.value)}
                            placeholder="이벤트·로봇·작업·자원 검색"
                          />
                        </label>
                      </div>
                      <div className="table-scroll event-table">
                        <table>
                          <thead>
                            <tr>
                              <th>시각 (s)</th>
                              <th>이벤트</th>
                              <th>로봇 / 자원</th>
                              <th>작업</th>
                              <th>상태 변화 · 원인</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredEvents
                              .slice(-200)
                              .reverse()
                              .map((e) => (
                                <tr key={e.sequence}>
                                  <td className="mono">{number(e.time, 3)}</td>
                                  <td>
                                    <span className="event-kind">{e.kind}</span>
                                  </td>
                                  <td>{e.robotId ?? e.resourceId ?? "—"}</td>
                                  <td>{e.jobId ?? "—"}</td>
                                  <td>
                                    {e.message}
                                    {e.cause && <small>{e.cause}</small>}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <section className="model-notes">
                      <strong>모델의 가정과 분석 한계</strong>
                      <p>{result.assumptions.join(" · ")}</p>
                      <p>
                        예시 입력은 테스트 가정입니다. P95는 완료 작업 분포이며
                        반복 평균의 신뢰구간이 아닙니다. 미완료 작업과 종료 시
                        재고는 결과 JSON에 별도로 남습니다. 실장비
                        안전성·SLAM·모터 제어 검증은 이 모델의 범위에 포함되지
                        않습니다.
                      </p>
                    </section>
                  </>
                )}
              </>
            )}

            {page !== "results" && page !== "planning" && (
              <div className="bottom-grid">
                <section className="validation-card">
                  <div className="card-heading">
                    <div>
                      <h2>
                        모델 검사{" "}
                        <span
                          className={`count-label ${errors.length ? "error" : ""}`}
                        >
                          {errors.length} 오류 · {issues.length - errors.length}{" "}
                          검토
                        </span>
                      </h2>
                      <small>
                        참조 무결성, 연결 상태와 입력 범위를 확인합니다.
                      </small>
                    </div>
                    <span
                      className={`validation-mark ${errors.length ? "error" : ""}`}
                    >
                      <Icon
                        name={errors.length ? "settings" : "check"}
                        size={16}
                      />
                      {errors.length ? "확인 필요" : "실행 가능"}
                    </span>
                  </div>
                  <div className="validation-list">
                    {issues.length ? (
                      issues.slice(0, 20).map((i, n) => (
                        <button
                          key={n}
                          onClick={() => {
                            if (i.entityId) {
                              setSelected([i.entityId]);
                              setPanel("selection");
                              setPage("edit");
                            }
                          }}
                        >
                          <span className={`issue-dot ${i.severity}`} />
                          <span>
                            {i.message}
                            <small>{i.entityId ?? i.code}</small>
                          </span>
                          <span className="issue-tag">
                            {i.severity === "error" ? "오류" : "검토"}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="validation-ok">
                        <Icon name="check" />
                        <div>
                          <strong>기본 검사를 통과했습니다.</strong>
                          <p>
                            실행 결과의 이벤트·재고·대기 원인을 함께 검토하세요.
                          </p>
                        </div>
                      </div>
                    )}
                    {displaySnapshot?.diagnostics.map((d, i) => (
                      <p className="runtime-diagnostic" key={`d${i}`}>
                        {d.message}
                      </p>
                    ))}
                  </div>
                </section>
                <section className="recent-events">
                  <div className="card-heading">
                    <div>
                      <h2>최근 이벤트</h2>
                      <small>엔진이 기록한 실제 상태 변화</small>
                    </div>
                    <span className="tiny-pill">
                      {number(displaySnapshot?.eventCount ?? 0, 0)}
                    </span>
                  </div>
                  <div className="recent-event-list">
                    {currentEvents.length ? (
                      currentEvents
                        .slice(-5)
                        .reverse()
                        .map((e) => (
                          <div key={e.sequence}>
                            <span className="mono">{number(e.time, 1)} s</span>
                            <i />
                            <p>
                              <strong>{e.kind}</strong>
                              <small>{e.message}</small>
                            </p>
                          </div>
                        ))
                    ) : (
                      <div className="events-empty">
                        <Icon name="route" />
                        <p>
                          시뮬레이션을 시작하면
                          <br />
                          생산·운송·충전 이벤트가 표시됩니다.
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}
          </>
        )}
        <footer className="workspace-footer">
          <span>CROIS Simulation Studio · SimPy DES</span>
          <span>Web · 2D / 3D · Discrete Event Simulation · Local-first</span>
        </footer>
      </main>
      <input
        type="file"
        accept="application/json,.json"
        hidden
        ref={importRef}
        onChange={importFile}
      />
      <input
        type="file"
        accept="image/png,image/jpeg"
        hidden
        ref={backgroundRef}
        onChange={uploadBackground}
      />
      {notice && (
        <div className="toast" role="status">
          <Icon name="file" />
          {notice}
          <button aria-label="알림 닫기" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function JsonInput({
  value,
  onApply,
}: {
  value: unknown;
  onApply: (v: unknown) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value));
  const [error, setError] = useState("");
  useEffect(() => setText(JSON.stringify(value)), [value]);
  return (
    <>
      <input
        aria-invalid={Boolean(error)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(text);
            if (
              parsed === null ||
              Array.isArray(parsed) ||
              typeof parsed !== "object" ||
              Object.values(parsed).some(
                (n) =>
                  typeof n !== "number" ||
                  !Number.isFinite(n) ||
                  n < 0 ||
                  !Number.isInteger(n),
              )
            )
              throw new Error("수량은 0 이상의 정수여야 합니다.");
            onApply(parsed);
            setError("");
          } catch (e) {
            setError(String(e));
          }
        }}
      />
      {error && <small className="danger">{error}</small>}
    </>
  );
}
