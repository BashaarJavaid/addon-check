import { expect, test } from "@playwright/test";

test("official non-Hirz card, explicit review, Dot, themes and no replay speech", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", { value: { cancel() {}, getVoices() { return []; }, speak() { document.documentElement.dataset.spoken = String(Number(document.documentElement.dataset.spoken ?? 0) + 1); } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Discover tools" }).click();
  await expect(page.getByRole("combobox", { name: "Tool", exact: true })).toHaveValue("get-time");
  await page.getByLabel("Speak responses").check();
  await page.getByRole("button", { name: "Review call", exact: true }).click();
  const question = page.getByRole("region", { name: "Pending question" });
  await expect(question).toBeFocused();
  await question.getByRole("checkbox").check();
  await question.getByRole("button", { name: "Submit response" }).click();
  const card = page.frameLocator('iframe[title="MCP App card"]');
  await expect(card.locator("#server-time")).toHaveText(/\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("light");
  await expect(card.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "test-results/reference-card.png", fullPage: true });
  await card.locator("#get-time-btn").click();
  await expect(question).toBeVisible();
  await question.getByRole("checkbox").check();
  await question.getByRole("button", { name: "Submit response" }).click();
  await expect(page.locator(".sim-transcript article")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Display", exact: true }).selectOption("dot");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".sim-transcript article")).toHaveCount(2);
  await expect(page.locator("html")).not.toHaveAttribute("data-spoken");
  // A declined call never creates a successful receipt.
  await page.getByRole("button", { name: "Discover tools" }).click();
  await page.getByRole("button", { name: "Review call", exact: true }).click();
  await question.getByRole("button", { name: "decline", exact: true }).click();
  await expect(page.getByText(/Call stopped or refused/).first()).toBeVisible();
});

test("CSRF, sibling browser isolation and invalid arguments fail before execution", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Discover tools" }).click();
  const refused = await page.evaluate(async () => (await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "get-time", arguments: {} }) })).status);
  expect(refused).toBe(403);
  await page.getByLabel("Arguments (JSON)").fill("not json");
  await page.getByRole("button", { name: "Review call", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("region", { name: "Pending question" })).toHaveCount(0);
  const other = await browser.newContext();
  const sibling = await other.newPage();
  await sibling.goto("/");
  await expect(sibling.locator(".sim-transcript article")).toHaveCount(0);
  await other.close();
});
