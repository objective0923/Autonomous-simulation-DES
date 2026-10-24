import assert from "node:assert/strict";
import type { Page } from "playwright";

export async function createScenarioThroughUi(
  page: Page,
  customerName: string,
  name: string,
) {
  await page.getByTestId("scenario-library").waitFor();
  await page.getByLabel("고객 이름", { exact: true }).fill(customerName);
  await page.getByLabel("시나리오 이름", { exact: true }).fill(name);
  const [result] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/scenarios") && r.request().method() === "POST",
    ),
    page.locator(".scenario-create-card form").getByRole("button").click(),
  ]);
  assert.equal(result.status(), 201, await result.text());
  const detail = await result.json();
  await page.getByTestId("scenario-wizard").waitFor();
  return detail as { id: string; customerName: string; name: string };
}

export async function openScenarioThroughUi(page: Page, id: string) {
  await page.getByTestId("scenario-library").waitFor();
  const card = page.locator(`[data-scenario-id="${id}"]`);
  await card.getByRole("button", { name: "열기", exact: true }).click();
  await page.getByTestId("scenario-wizard").waitFor();
}

export async function wizardStep(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "시나리오 입력 단계", exact: true })
    .getByRole("button", { name: new RegExp(`: ${name}$`) })
    .click();
}

export async function expandDetails(page: Page, text: string) {
  const summary = page.locator("summary").filter({ hasText: text }).first();
  const open = await summary.evaluate(
    (e) => (e.parentElement as HTMLDetailsElement).open,
  );
  if (!open) await summary.click();
}
