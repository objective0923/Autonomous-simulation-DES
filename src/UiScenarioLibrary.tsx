import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  deleteScenario,
  getScenario,
  listScenarios,
  scenarioKey,
  type ScenarioDetail,
  type ScenarioSummary,
} from "./scenarios";
import type { Project, SimulationResult } from "./types";
import "./UiScenarioLibrary.css";

export interface ScenarioImport {
  project: Project;
  result?: SimulationResult;
}
interface Props {
  revision: number;
  pendingImport: ScenarioImport | null;
  legacy: Project | null;
  onCreate: (
    customer: string,
    name: string,
    template?: ScenarioImport,
  ) => Promise<void>;
  onOpen: (scenario: ScenarioDetail, showResult?: boolean) => Promise<void>;
  onCopy: (scenario: ScenarioDetail) => Promise<void>;
  onDeleted: (id: string) => void;
  onImportLegacy: () => void;
  onClearImport: () => void;
}
const time = (value: string) =>
  new Date(value).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export default function UiScenarioLibrary({
  revision,
  pendingImport,
  legacy,
  onCreate,
  onOpen,
  onCopy,
  onDeleted,
  onImportLegacy,
  onClearImport,
}: Props) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [customer, setCustomer] = useState(""),
    [name, setName] = useState(""),
    [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null),
    [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    listScenarios(controller.signal)
      .then(setScenarios)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, refresh]);
  useEffect(() => {
    if (pendingImport) {
      setCustomer(pendingImport.project.customerName ?? "");
      setName(pendingImport.project.name);
    }
  }, [pendingImport]);
  const groups = useMemo(() => {
    const found = scenarios.filter((s) =>
      `${s.customerName} ${s.name}`
        .toLocaleLowerCase("ko-KR")
        .includes(search.trim().toLocaleLowerCase("ko-KR")),
    );
    const map = new Map<string, { name: string; items: ScenarioSummary[] }>();
    for (const s of found) {
      const key = scenarioKey(s.customerName);
      const g = map.get(key) ?? { name: s.customerName, items: [] };
      g.items.push(s);
      map.set(key, g);
    }
    return [...map.values()];
  }, [scenarios, search]);
  const customers = [
    ...new Map(
      scenarios.map((s) => [scenarioKey(s.customerName), s.customerName]),
    ).values(),
  ];
  const action = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action("create", async () => {
      if (!customer.trim() || !name.trim())
        throw new Error("고객 이름과 시나리오 이름을 입력하세요.");
      await onCreate(customer.trim(), name.trim(), pendingImport ?? undefined);
    });
  };
  return (
    <div className="scenario-library" data-testid="scenario-library">
      <section className="scenario-welcome">
        <span className="eyebrow">CUSTOMER SCENARIOS</span>
        <h1>고객별 시나리오를 시작하세요</h1>
        <p>
          이름 두 개로 시작하고, 한 단계씩 입력하세요. 작업은 이 PC에 자동
          저장됩니다.
        </p>
        <div className="scenario-process">
          <span>01 고객 · 시나리오</span>
          <i>→</i>
          <span>02 순서대로 입력</span>
          <i>→</i>
          <span>03 검토 · 실행</span>
        </div>
      </section>
      <section className="scenario-create-card" aria-label="새 시나리오 만들기">
        <div>
          <span className="scenario-card-icon">＋</span>
          <h2>
            {pendingImport ? "가져온 입력을 저장하세요" : "새 시나리오 만들기"}
          </h2>
          <p>
            {pendingImport
              ? "고객 이름을 지정하면 가져온 입력이 고객별 저장함에 보관됩니다."
              : "나머지는 예제로 준비해 드립니다. 실제 사양은 다음 단계에서 바꿀 수 있습니다."}
          </p>
        </div>
        <form onSubmit={submit}>
          <label>
            고객 이름
            <input
              name="customerName"
              aria-label="고객 이름"
              required
              maxLength={120}
              list="scenario-customer-names"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="예: CROIS 고객사"
              disabled={busy !== null}
            />
          </label>
          <datalist id="scenario-customer-names">
            {customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <label>
            시나리오 이름
            <input
              name="scenarioName"
              aria-label="시나리오 이름"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: A창고 6단 검토"
              disabled={busy !== null}
            />
          </label>
          <button
            className="button primary"
            disabled={busy !== null}
            type="submit"
          >
            {busy === "create" ? "저장 중…" : "시나리오 만들기"}
            <span>→</span>
          </button>
        </form>
        {pendingImport && (
          <button
            className="text-button"
            disabled={busy !== null}
            onClick={() => {
              onClearImport();
              setCustomer("");
              setName("");
            }}
          >
            가져오기 취소
          </button>
        )}
      </section>
      {legacy && !pendingImport && (
        <div className="scenario-legacy">
          <div>
            <strong>이전 브라우저 저장을 찾았습니다.</strong>
            <span>
              {legacy.name} · 고객 이름을 지정해 새 저장함으로 가져올 수
              있습니다.
            </span>
          </div>
          <button
            className="button small"
            disabled={busy !== null}
            onClick={onImportLegacy}
          >
            이전 저장 가져오기
          </button>
        </div>
      )}
      {error && (
        <div className="scenario-library-error" role="alert">
          <span>{error}</span>
          <button
            className="button small"
            onClick={() => setRefresh((v) => v + 1)}
          >
            다시 불러오기
          </button>
        </div>
      )}
      <section className="scenario-saved">
        <div className="scenario-saved-heading">
          <div>
            <h2>
              저장한 시나리오 <span>{scenarios.length}</span>
            </h2>
            <p>고객별로 열고, 복제해 대안을 만드세요.</p>
          </div>
          <label className="scenario-search">
            검색
            <input
              aria-label="고객 또는 시나리오 검색"
              placeholder="고객 또는 시나리오 이름"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        {loading ? (
          <div className="scenario-empty" role="status">
            저장함을 불러오는 중입니다…
          </div>
        ) : groups.length ? (
          groups.map((group) => (
            <section
              className="scenario-customer-group"
              key={scenarioKey(group.name)}
            >
              <h3>
                <span className="scenario-customer-icon">
                  {group.name.slice(0, 1)}
                </span>
                {group.name}
                <small>{group.items.length}개 시나리오</small>
              </h3>
              <div className="scenario-card-grid">
                {group.items.map((s) => (
                  <article
                    className="saved-scenario-card"
                    key={s.id}
                    data-scenario-id={s.id}
                    data-testid="scenario-card"
                  >
                    <div className="saved-scenario-top">
                      <span
                        className={`scenario-result-pill ${s.hasResult ? "has-result" : ""}`}
                      >
                        {s.hasResult ? "최근 결과 저장됨" : "입력 작성 중"}
                      </span>
                      <button
                        className="scenario-delete-button"
                        aria-label={`${s.name} 삭제`}
                        disabled={busy !== null}
                        onClick={() => setConfirmDelete(s.id)}
                      >
                        삭제
                      </button>
                    </div>
                    <h4>{s.name}</h4>
                    <p>수정 {time(s.updatedAt)}</p>
                    {confirmDelete === s.id ? (
                      <div className="scenario-delete-confirm">
                        <span>이 시나리오와 저장 결과를 삭제할까요?</span>
                        <div>
                          <button
                            className="button small danger"
                            disabled={busy !== null}
                            onClick={() =>
                              void action(s.id, async () => {
                                await deleteScenario(s.id);
                                setScenarios((list) =>
                                  list.filter((x) => x.id !== s.id),
                                );
                                setConfirmDelete(null);
                                onDeleted(s.id);
                              })
                            }
                          >
                            삭제 확인
                          </button>
                          <button
                            className="button small"
                            onClick={() => setConfirmDelete(null)}
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="scenario-card-actions">
                        <button
                          className="button primary small"
                          disabled={busy !== null}
                          onClick={() =>
                            void action(s.id, async () =>
                              onOpen(await getScenario(s.id)),
                            )
                          }
                        >
                          열기
                        </button>
                        <button
                          className="button small"
                          disabled={busy !== null}
                          onClick={() =>
                            void action(s.id, async () =>
                              onCopy(await getScenario(s.id)),
                            )
                          }
                        >
                          복제
                        </button>
                        {s.hasResult && (
                          <button
                            className="button small"
                            disabled={busy !== null}
                            onClick={() =>
                              void action(s.id, async () =>
                                onOpen(await getScenario(s.id), true),
                              )
                            }
                          >
                            최근 결과
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="scenario-empty">
            <strong>
              {search
                ? "검색한 시나리오가 없습니다."
                : "아직 저장한 시나리오가 없습니다."}
            </strong>
            <p>
              {search
                ? "다른 이름으로 검색해 보세요."
                : "위에서 고객과 시나리오 이름을 입력하면 바로 시작할 수 있습니다."}
            </p>
          </div>
        )}
      </section>
      <p className="scenario-storage-note">
        이 PC의 저장함에 입력과 최근 계산 결과를 보관합니다. 다른 PC로 옮길 때는
        시나리오에서 ‘파일 내보내기’를 이용하세요.
      </p>
    </div>
  );
}
