import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserHarness } from "./browser-harness";
import {
  createScenarioThroughUi,
  openScenarioThroughUi,
  wizardStep,
} from "./browser-scenarios";

const artifacts = path.resolve("artifacts/browser");
await mkdir(artifacts, { recursive: true });
const harness = await browserHarness(4177, 8013);
try {
  const { browser, url } = harness;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  const library = page.getByTestId("scenario-library");
  await library.waitFor();
  assert.equal(
    await library.locator("form input:not([type=hidden])").count(),
    2,
    "시작에 필요한 입력은 고객·시나리오 두 개여야 합니다.",
  );
  await page.screenshot({
    path: path.join(artifacts, "customer-library.png"),
    fullPage: true,
  });
  const first = await createScenarioThroughUi(
    page,
    "테스트 고객 A",
    "창고 기본안",
  );
  assert.equal(
    await page.getByTestId("scenario-wizard").getAttribute("data-step"),
    "0",
  );
  assert.equal(
    await page.getByLabel(/로봇 외형 폭/).count(),
    0,
    "도면 단계에 다른 단계 사양을 한꺼번에 노출하지 않아야 합니다.",
  );
  await page
    .getByRole("button", { name: "도면은 나중에", exact: true })
    .click();
  await page.getByLabel(/건물 유효 가로/).fill("41");
  await page.getByRole("button", { name: /다음: 로봇/ }).click();
  assert.equal(
    await page.getByLabel(/로봇 외형 폭/).inputValue(),
    "",
    "실제 미제공 사양은 미확인 상태여야 합니다.",
  );
  assert.equal(
    await page
      .getByText("고급 설정 · 내부 선반과 하중", { exact: true })
      .evaluate((e) => (e.parentElement as HTMLDetailsElement).open),
    false,
  );
  await page
    .getByRole("button", { name: "사양은 나중에", exact: true })
    .click();
  await page.getByLabel(/^검토할 랙 단수/).fill("20");
  await page.getByRole("button", { name: /다음: 높이 검토/ }).click();
  assert.equal(await page.locator(".elevation-table tbody tr").count(), 20);
  await page.screenshot({
    path: path.join(artifacts, "simple-wizard.png"),
    fullPage: true,
  });

  // A newer edit must survive a slow older save and navigation away from the form.
  await wizardStep(page, "공간");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const savingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let delayed = false;
  await page.route(`**/api/scenarios/${first.id}`, async (route) => {
    if (route.request().method() === "PUT" && !delayed) {
      delayed = true;
      started?.();
      await gate;
    }
    await route.continue();
  });
  await page.getByLabel(/건물 유효 가로/).fill("42");
  await Promise.race([
    savingStarted,
    delay(10000).then(() => {
      throw new Error("자동 저장 요청 시간 초과");
    }),
  ]);
  await page.getByLabel(/건물 유효 가로/).fill("43");
  await page
    .getByRole("button", { name: "고객별 저장함 열기", exact: true })
    .click();
  release?.();
  await library.waitFor();
  await page.unroute(`**/api/scenarios/${first.id}`);
  const get = async (id: string) => {
    const response = await fetch(`${url}/api/scenarios/${id}`);
    assert(response.ok);
    return response.json();
  };
  assert.equal((await get(first.id)).project.spacePlan.building.width, 43);
  assert.equal(
    (await get(first.id)).project.spacePlan.layout.requestedLevels,
    20,
  );

  await harness.restartApi();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "networkidle" });
  await openScenarioThroughUi(page, first.id);
  await wizardStep(page, "공간");
  assert.equal(
    await page.getByLabel(/건물 유효 가로/).inputValue(),
    "43",
    "입력은 브라우저 캐시와 서버 프로세스를 넘어 보존되어야 합니다.",
  );
  // A failed save must remain visible and recover without losing the current draft.
  await page.route(`**/api/scenarios/${first.id}`, async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "테스트 저장 실패" }),
      });
    else await route.continue();
  });
  await page.getByLabel(/건물 유효 세로/).fill("25");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="scenario-save-status"]')
        ?.getAttribute("data-state") === "error",
  );
  await page
    .getByRole("button", { name: "고객별 저장함 열기", exact: true })
    .click();
  assert.equal(
    await library.count(),
    0,
    "저장 실패 시 입력을 두고 다른 시나리오로 이동하면 안 됩니다.",
  );
  await page.unroute(`**/api/scenarios/${first.id}`);
  await page
    .getByRole("button", { name: "저장 다시 시도", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="scenario-save-status"]')
        ?.getAttribute("data-state") === "saved",
  );
  assert.equal((await get(first.id)).project.spacePlan.building.depth, 25);

  // Leaving while pre-run save is slow must not reopen a stale run or duplicate requests.
  let releaseRunSave: (() => void) | undefined;
  const runGate = new Promise<void>((resolve) => {
    releaseRunSave = resolve;
  });
  let runSaveStarted: (() => void) | undefined;
  const runSaving = new Promise<void>((resolve) => {
    runSaveStarted = resolve;
  });
  await page.route(`**/api/scenarios/${first.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      runSaveStarted?.();
      await runGate;
    }
    await route.continue();
  });
  await page.getByLabel(/건물 유효 세로/).fill("26");
  await wizardStep(page, "배치");
  await page
    .getByRole("button", { name: "시뮬레이션 실행 →", exact: true })
    .click();
  await Promise.race([
    runSaving,
    delay(10000).then(() => {
      throw new Error("계산 전 저장 요청 시간 초과");
    }),
  ]);
  await page
    .getByRole("button", { name: "고객별 저장함 열기", exact: true })
    .click();
  releaseRunSave?.();
  await library.waitFor();
  await page.unroute(`**/api/scenarios/${first.id}`);
  await page.waitForLoadState("networkidle");
  assert.equal(
    await library.count(),
    1,
    "취소한 계산 응답이 저장함 화면을 바꾸면 안 됩니다.",
  );
  assert.equal((await get(first.id)).project.spacePlan.building.depth, 26);
  await page
    .locator(`[data-scenario-id="${first.id}"]`)
    .getByRole("button", { name: "복제", exact: true })
    .click();
  await page.getByTestId("scenario-wizard").waitFor();
  await wizardStep(page, "공간");
  await page.getByLabel(/건물 유효 가로/).fill("30");
  await page
    .getByRole("button", { name: "고객별 저장함 열기", exact: true })
    .click();
  await library.waitFor();
  const listing = await (await fetch(`${url}/api/scenarios`)).json();
  const copy = listing.scenarios.find((s: { id: string }) => s.id !== first.id);
  assert(copy);
  assert.equal((await get(first.id)).project.spacePlan.building.width, 43);
  assert.equal((await get(copy.id)).project.spacePlan.building.width, 30);
  const secondCustomer = await createScenarioThroughUi(
    page,
    "테스트 고객 B",
    "창고 기본안",
  );
  await wizardStep(page, "배치");
  await page
    .getByRole("button", { name: "시뮬레이션 실행 →", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "로봇 상태별 시간", exact: true })
    .waitFor();
  const executed = await get(secondCustomer.id);
  assert(executed.hasResult && executed.result);
  assert.equal(executed.result.projectId, secondCustomer.id);
  assert.equal(executed.result.kpis.productionCompleted, 6);
  await page
    .getByRole("button", { name: "고객별 저장함 열기", exact: true })
    .click();
  await library.waitFor();
  await page
    .locator(`[data-scenario-id="${secondCustomer.id}"]`)
    .getByRole("button", { name: "최근 결과", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "로봇 상태별 시간", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "고객별 저장함 열기", exact: true })
    .click();
  await library.waitFor();
  const copyCard = page.locator(`[data-scenario-id="${copy.id}"]`);
  await copyCard.getByRole("button", { name: /삭제/ }).click();
  await copyCard
    .getByRole("button", { name: "삭제 확인", exact: true })
    .click();
  await copyCard.waitFor({ state: "detached" });
  assert.equal(
    (await (await fetch(`${url}/api/scenarios`)).json()).scenarios.length,
    2,
  );
  await page.screenshot({
    path: path.join(artifacts, "saved-customer-scenarios.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Customer/scenario workflow passed: two-field creation, sequential draft inputs, serialized autosave, navigation flush, process restart, cache-independent persistence, independent copy, saved SimPy result and targeted deletion.",
  );
} finally {
  await harness.close();
}
