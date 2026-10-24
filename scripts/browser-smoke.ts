import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { browserHarness } from "./browser-harness";
import { parseSavedRun } from "../src/replay";

const artifacts = path.resolve("artifacts/browser");
await mkdir(artifacts, { recursive: true });
const harness = await browserHarness(
  Number(process.env.CROIS_TEST_PORT ?? 4173),
  8011,
);
const { browser, url } = harness;
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    acceptDownloads: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "공간과 운영을 설계하세요" })
    .waitFor();
  assert.match(await page.locator(".validation-mark").innerText(), /실행 가능/);
  // Map edits and reversible history change actual project state.
  const map = page.getByTestId("factory-map");
  const nodeCount = () => page.locator(".canvas-tags").innerText();
  assert.match(await nodeCount(), /8 NODES/);
  await page.getByRole("button", { name: "노드 추가", exact: true }).click();
  await map.click({ position: { x: 30, y: 30 } });
  assert.match(await nodeCount(), /9 NODES/);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  assert.match(await nodeCount(), /8 NODES/);
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  assert.match(await nodeCount(), /9 NODES/);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await page.getByRole("button", { name: "조건", exact: true }).click();
  await page
    .getByLabel("프로젝트 이름", { exact: true })
    .fill("브라우저 검증 라인");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "조건", exact: true }).click();
  assert.equal(
    await page.getByLabel("프로젝트 이름", { exact: true }).inputValue(),
    "브라우저 검증 라인",
  );
  await page.screenshot({
    path: path.join(artifacts, "editor.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "이벤트 단위 진행", exact: true })
    .click();
  await page.getByRole("heading", { name: "실시간 자원 상태", exact: true }).waitFor();
  await page.getByRole("button", { name: /공간 · 모델 편집/ }).click();
  await page.getByRole("button", { name: "조건", exact: true }).click();
  assert(
    await page.getByLabel("종료 시각 (s)", { exact: true }).isDisabled(),
    "실행 중에는 입력이 잠겨야 합니다.",
  );
  await page.getByRole("button", { name: "전체 계산", exact: true }).click();
  await page
    .getByRole("heading", { name: "로봇 상태별 시간", exact: true })
    .waitFor();
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 JSON", exact: true }).click();
  const json = await jsonDownload;
  const runPath = path.join(artifacts, "saved-run.json");
  await json.saveAs(runPath);
  const saved = parseSavedRun(JSON.parse(await readFile(runPath, "utf8")));
  const response = await fetch(`${url}/api/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: saved.input }),
  });
  assert(response.ok, "SimPy API가 실행 결과를 반환해야 합니다.");
  const expected = await response.json();
  assert.match(saved.result.engineVersion, /simpy/i);
  assert.deepEqual(
    saved.result.kpis,
    expected.kpis,
    "브라우저와 화면 없는 실행의 KPI가 같아야 합니다.",
  );
  // JSON omits optional undefined keys; compare the persisted event representation.
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(
    digest(saved.result.events),
    digest(expected.events),
    "동일 입력의 이벤트 순서가 같아야 합니다.",
  );
  assert(
    saved.result.kpis.productionCompleted > 0 &&
      saved.result.kpis.transportCompleted > 0,
  );
  await page.getByRole("button", { name: "비교에 추가", exact: true }).click();
  assert.equal(await page.locator(".comparison-card tbody tr").count(), 1);
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "이벤트 CSV", exact: true }).click();
  const csv = await csvDownload;
  await csv.saveAs(path.join(artifacts, "events.csv"));
  assert.match(
    await readFile(path.join(artifacts, "events.csv"), "utf8"),
    /"time_s"/,
  );
  await page.screenshot({
    path: path.join(artifacts, "results.png"),
    fullPage: true,
  });
  // Opening a recorded run must load its history without generating new results.
  await page
    .locator('input[type=file][accept="application/json,.json"]')
    .setInputFiles(runPath);
  await page
    .getByRole("heading", { name: "기록 기반 재생", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "처음 상태 보기", exact: true })
    .click();
  assert.match(await page.locator(".simulation-clock").innerText(), /00:00:00/);
  assert(
    await page.getByRole("button", { name: "초기화", exact: true }).isEnabled(),
  );
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await page.getByRole("button", { name: /공간 · 모델 편집/ }).click();
  await page.getByRole("button", { name: "조건", exact: true }).click();
  assert(await page.getByLabel("종료 시각 (s)", { exact: true }).isEnabled());
  assert.deepEqual(errors, [], "브라우저 런타임 오류가 없어야 합니다.");
  console.log(
    `Browser workflow passed: edit/undo/redo/save/reload/step/input lock/run/export/compare/import/replay. Production=${saved.result.kpis.productionCompleted}, transports=${saved.result.kpis.transportCompleted}, events=${saved.result.events.length}.`,
  );
  console.log(`Screenshots and exports: ${artifacts}`);
} finally {
  await harness.close();
}
