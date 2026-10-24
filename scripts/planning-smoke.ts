import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { browserHarness } from "./browser-harness";
import { parseProject } from "../src/model";
import { compareRackLevels, resolveVerticalGeometry } from "../src/planning";
import {
  createScenarioThroughUi,
  openScenarioThroughUi,
  wizardStep,
  expandDetails,
} from "./browser-scenarios";

const artifacts = path.resolve("artifacts/browser");
await mkdir(artifacts, { recursive: true });
const harness = await browserHarness(4175, 8012);
try {
  const { browser, url } = harness;
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    acceptDownloads: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    '<style>@page{size:800px 600px;margin:0}body{margin:0}.sheet{height:600px;break-after:page;box-sizing:border-box;padding:40px;border:8px solid #333}</style><div class="sheet"><h1>Warehouse A / 10000 mm</h1><svg width="700" height="400"><rect x="20" y="20" width="600" height="300" fill="none" stroke="black" stroke-width="3"/><text x="100" y="100">10000 mm</text></svg></div><div class="sheet"><h1>Warehouse B / 6000 mm</h1><p>Second floor plan</p></div>',
  );
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const scenario = await createScenarioThroughUi(
    page,
    "도면 검증 고객",
    "20단 배치 검토",
  );
  await page.getByLabel("원본 PNG JPG PDF 업로드").setInputFiles({
    name: "customer-warehouse.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page
    .locator(".source-file")
    .getByText("customer-warehouse.pdf", { exact: true })
    .waitFor();
  assert.match(await page.locator(".source-file").innerText(), /PDF 1페이지/);
  await page.getByRole("button", { name: "다음 페이지", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".source-file")
      ?.textContent?.includes("PDF 2페이지"),
  );
  await page.getByRole("button", { name: "이전 페이지", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".source-file")
      ?.textContent?.includes("PDF 1페이지"),
  );
  await page
    .getByRole("button", { name: "기준점 2개 지정", exact: true })
    .click();
  const drawing = page.getByRole("img", {
    name: "기준점 선택용 원본 도면",
    exact: true,
  });
  await drawing.scrollIntoViewIfNeeded();
  const points = await drawing.evaluate((element) => {
    const svg = element as SVGSVGElement,
      box = svg.viewBox.baseVal,
      matrix = svg.getScreenCTM()!;
    return [0.2, 0.7].map((f) => {
      const p = svg.createSVGPoint();
      p.x = box.width * f;
      p.y = box.height * 0.35;
      const q = p.matrixTransform(matrix);
      return { x: q.x, y: q.y };
    });
  });
  for (const point of points) await page.mouse.click(point.x, point.y);
  await page.getByLabel("실제 기준거리 m", { exact: true }).fill("10");
  await page
    .getByLabel("축척 확인 근거", { exact: true })
    .fill("브라우저 검증: 고객 PDF 1페이지의 10000 mm 기준선");
  await page.getByLabel("축척과 기준거리 확인", { exact: true }).check();
  assert.match(await page.locator(".source-status").innerText(), /확인됨/);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  await openScenarioThroughUi(page, scenario.id);
  assert(
    await page.getByLabel("축척과 기준거리 확인", { exact: true }).isChecked(),
  );
  assert.equal(
    await page.locator(".source-stage circle").count(),
    2,
    "축척 기준점이 저장되어야 합니다.",
  );
  await page.screenshot({
    path: path.join(artifacts, "pdf-calibration.png"),
    fullPage: true,
  });

  await wizardStep(page, "공간");
  await page.getByLabel(/유효 천장 높이/).fill("3");
  await wizardStep(page, "로봇");
  assert.equal(
    await page.getByLabel(/로봇 외형 폭/).inputValue(),
    "",
    "실제 미제공 로봇 치수를 임의로 채우면 안 됩니다.",
  );
  await page
    .locator("summary")
    .filter({ hasText: "고급 설정 · 내부 선반과 하중" })
    .click();
  await page
    .getByRole("button", { name: "DEMO 로봇 가정값 입력", exact: true })
    .click();
  await page.getByLabel(/최저 인계 가능 높이/).fill("0.1");
  await page.getByLabel(/^최고 인계 가능 높이/).fill("2.6");
  await page.getByLabel(/마스트 최대 상승 전고/).fill("3");
  await page.getByLabel(/장비 첫 선반 높이/).fill("0.15");
  await page.getByLabel(/장비 선반 피치/).fill("0.42483333333333334");
  await page.getByLabel(/장비 내부 선반 수/).fill("6");
  await wizardStep(page, "랙");
  await expandDetails(page, "고급 설정 · 랙 크기·여유·하중");
  await page
    .getByLabel(/첫 선반 높이/)
    .last()
    .fill("0.15");
  await page.getByLabel(/운송물 높이/).fill("0.3");
  await page.getByLabel(/인계 상승 여유/).fill("0.07");
  await expandDetails(page, "예제 · 파일 불러오기");
  await page
    .getByRole("button", { name: "첨부 2,699 mm 예제 적용", exact: true })
    .click();
  assert.match(await page.locator(".elevation-facts").innerText(), /2,699/);
  await wizardStep(page, "랙");
  await page.getByLabel(/랙 높이 산정 방식/).selectOption("pitch");
  await page.getByLabel(/^선반 간 피치/).fill("0.42483333333333334");
  // Field labels are kept explicit to verify the supplied vertical model in the UI.
  await wizardStep(page, "높이 검토");
  await expandDetails(page, "다른 단수와 비교");
  await page.getByLabel(/대안 B 단수/).fill("20");
  await page.getByLabel(/측면도 기준 단수/).fill("20");
  await page.getByTestId("rack-elevation").waitFor();
  assert.equal(await page.locator(".elevation-table tbody tr").count(), 20);
  await page.getByLabel("측면도 표시 단위", { exact: true }).selectOption("m");
  assert.match(
    await page.locator(".elevation-table thead").innerText(),
    /인계면 \(m\)/,
  );
  await page.getByLabel("측면도 표시 단위", { exact: true }).selectOption("mm");
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "측면도 SVG", exact: true }).click();
  const svg = await svgDownload;
  await svg.saveAs(path.join(artifacts, "rack-20-elevation.svg"));
  assert.match(
    await readFile(path.join(artifacts, "rack-20-elevation.svg"), "utf8"),
    /랙 20단/,
  );
  await page.screenshot({
    path: path.join(artifacts, "rack-elevation.png"),
    fullPage: true,
  });

  await wizardStep(page, "배치");
  await expandDetails(page, "배치 여유 조정");
  await page.getByLabel(/횡단 통로 폭/).fill("3");
  await page
    .getByRole("button", { name: "배치 후보 생성", exact: true })
    .click();
  const scene = page.getByTestId("planning-3d");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="planning-3d"]')
        ?.getAttribute("data-renderer") !== "starting",
  );
  assert.equal(
    await scene.getAttribute("data-renderer"),
    "webgl",
    "실제 Three.js WebGL 렌더링을 검증해야 합니다.",
  );
  assert.equal(await scene.locator("canvas").count(), 1);
  await scene.screenshot({ path: path.join(artifacts, "rack-layout-3d.png") });
  assert(
    await page
      .getByRole("button", { name: "후보를 2D 객체로 적용", exact: true })
      .isDisabled(),
    "높이 한계를 넘는 후보는 적용하면 안 됩니다.",
  );
  await wizardStep(page, "공간");
  await page.getByLabel(/유효 천장 높이/).fill("10");
  await wizardStep(page, "로봇");
  await page.getByLabel(/^최고 인계 가능 높이/).fill("9");
  await page.getByLabel(/마스트 최대 상승 전고/).fill("9.5");
  await wizardStep(page, "배치");
  await page
    .getByRole("button", { name: "배치 후보 생성", exact: true })
    .click();
  await scene.screenshot({
    path: path.join(artifacts, "rack-layout-feasible-3d.png"),
  });
  assert(
    await page
      .getByRole("button", { name: "후보를 2D 객체로 적용", exact: true })
      .isEnabled(),
    await page.locator(".plan-proposal-report").innerText(),
  );
  await page
    .getByRole("button", { name: "후보를 2D 객체로 적용", exact: true })
    .click();
  const projectDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "파일 내보내기", exact: true })
    .click();
  const file = await projectDownload;
  const projectPath = path.join(artifacts, "spatial-project.json");
  await file.saveAs(projectPath);
  const project = parseProject(JSON.parse(await readFile(projectPath, "utf8")));
  assert(project.spacePlan && project.spacePlan.layout.placements.length > 0);
  assert.equal(project.spacePlan.layout.requestedLevels, 20);
  assert.equal(
    project.spacePlan.robot.confirmed,
    false,
    "예제 사양을 확인 완료로 처리하면 안 됩니다.",
  );
  assert.equal(project.spacePlan.calibration.points?.length, 2);
  assert.equal(
    compareRackLevels(project.spacePlan, [20])[0].status,
    "needsReview",
    "미확인 예제 입력을 승인된 사양으로 처리하면 안 됩니다.",
  );
  assert(resolveVerticalGeometry(project.spacePlan, 20).totalHeight > 3);
  assert(project.objects.some((o) => o.id.startsWith("plan-rack-")));
  assert.deepEqual(
    errors,
    [],
    "PDF와 3D 화면에 브라우저 런타임 오류가 없어야 합니다.",
  );
  console.log(
    `Spatial workflow passed: local two-page PDF, stored scale points, unverified robot specs, 20-tier mm/m elevation+SVG, Three.js WebGL, ${project.spacePlan.layout.placements.length} provisional racks, JSON/2D integration.`,
  );
} finally {
  await harness.close();
}
