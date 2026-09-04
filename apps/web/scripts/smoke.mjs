/**
 * Browser smoke test: drives the built web app against a running API, exercising the
 * graph, timeline, simulate and imports views, and writes screenshots to ./smoke-out.
 *
 *   API_URL=http://localhost:4000 WEB_URL=http://localhost:5173 IDENTITY=jordan@example.com node scripts/smoke.mjs
 *
 * Requires a seeded database (pnpm --filter @cutover/api seed) and `vite preview` or `vite dev` running.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const IDENTITY = process.env.IDENTITY ?? "jordan@example.com";
const EVENT_NAME = process.env.EVENT_NAME ?? "TRBK Cutover";
const OUT = process.env.OUT_DIR ?? "smoke-out";
mkdirSync(OUT, { recursive: true });

// Use a pre-installed Chromium when present (e.g. PLAYWRIGHT_BROWSERS_PATH images); else Playwright's own.
const executablePath = process.env.PW_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  // favicon is not shipped; ignore its 404.
  if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`console: ${m.text()}`);
});
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().includes("favicon")) errors.push(`http ${r.status()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  if (!r.url().includes("favicon")) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
});

try {
// Authenticate before the first navigation so no unauthenticated request is made.
await page.addInitScript((who) => localStorage.setItem("cutover.identity", who), IDENTITY);
await page.goto(WEB);
await page.waitForSelector("table tbody tr a", { timeout: 15000 });
const link = page.getByRole("link", { name: EVENT_NAME, exact: true });
if ((await link.count()) === 0) throw new Error(`event "${EVENT_NAME}" is not in the list; seed it or set EVENT_NAME`);
console.log("event:", EVENT_NAME);
await link.first().click();

// The event opens on the dashboard; the graph is a tab away.
await page.waitForSelector("text=Situation", { timeout: 20000 });
await page.getByRole("button", { name: "Graph" }).click();

// Graph
await page.waitForSelector(".task-node", { timeout: 20000 });
await page.waitForTimeout(800);
const nodeCount = await page.locator(".task-node").count();
const criticalCount = await page.locator(".task-node.critical").count();
console.log(`graph: ${nodeCount} task nodes, ${criticalCount} critical`);
await page.screenshot({ path: `${OUT}/01-graph.png` });

// Select a node → panel
await page.locator(".task-node").filter({ hasText: "MIG-STM" }).first().click();
await page.waitForSelector(".side");
await page.screenshot({ path: `${OUT}/02-task-panel.png` });

// Timeline
await page.getByRole("button", { name: "Timeline" }).click();
await page.waitForSelector("svg.timeline rect.bar");
const bars = await page.locator("svg.timeline rect.bar").count();
console.log(`timeline: ${bars} bars`);
await page.screenshot({ path: `${OUT}/03-timeline.png` });

// Simulate: delay MIG-STM by 6h
await page.getByRole("button", { name: "Simulate" }).click();
await page.getByPlaceholder("task ref").fill("MIG-STM");
await page.locator("input[value='60']").first().fill("360");
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.waitForSelector(".impact");
const gatesAfter = await page.locator(".impact table tbody tr").first().textContent();
console.log("impact first gate row:", gatesAfter?.replace(/\s+/g, " ").trim());
await page.screenshot({ path: `${OUT}/04-simulate.png`, fullPage: true });

// Timeline with scenario ghosts
await page.getByRole("button", { name: "Timeline" }).click();
await page.waitForSelector("svg.timeline rect.ghost");
await page.screenshot({ path: `${OUT}/05-timeline-scenario.png` });

// Imports
await page.getByRole("button", { name: "Imports" }).click();
await page.waitForSelector("text=New import");
await page.locator("table tbody tr button.linkish").first().click();
await page.waitForSelector("text=Review:");
await page.screenshot({ path: `${OUT}/06-imports.png`, fullPage: true });

// Dashboard: go live, block a task through the UI, then check it surfaces and notifies.
// Notifications are deliberately silent while an event is in planning, so this has to
// happen before the block, exactly as it would on the night.
const goLive = page.getByRole("button", { name: "Go live" });
if (await goLive.count()) {
  await goLive.click();
  await page.waitForSelector(".badge.live", { timeout: 20000 });
}
await page.getByRole("button", { name: "Timeline" }).click();
await page.waitForSelector("svg.timeline rect.bar");
await page.locator("svg.timeline text", { hasText: "MIG-BAL" }).first().click();
await page.waitForSelector(".side");
await page.locator(".side select").first().selectOption("blocked");
await page.locator('.side input[placeholder^="note"]').fill("source extract is late");
await page.locator(".side button.primary").filter({ hasText: "Save" }).click();
await page.waitForTimeout(1500);

await page.getByRole("button", { name: "Dashboard" }).click();
await page.waitForSelector("text=Situation");
await page.waitForSelector("text=Critical path");
await page.waitForSelector("text=source extract is late", { timeout: 20000 });
const notifCard = await page.locator(".card").filter({ hasText: "Notifications" }).first().innerText();
console.log("notifications:", (notifCard.split("\n").find((l) => l.includes("pending")) ?? "(none)").trim());
const pending = Number(/(\d+) pending/.exec(notifCard)?.[1] ?? 0);
if (pending === 0) throw new Error("a blocked task on a live event queued no notifications");
const sendBtn = page.getByRole("button", { name: "Send pending" });
if (await sendBtn.isEnabled()) {
  await sendBtn.click();
  await page.waitForSelector("text=Dispatched", { timeout: 20000 });
  console.log("dispatch:", (await page.locator("text=Dispatched").first().innerText()).trim());
}
await page.screenshot({ path: `${OUT}/07-dashboard.png`, fullPage: true });

// Report
await page.getByRole("button", { name: "Report" }).click();
await page.waitForSelector("text=post-event report");
const tiles = await page.locator(".report .tile").count();
console.log(`report: ${tiles} summary tiles`);
await page.locator("button.chip").filter({ hasText: "tasks" }).first().click();
await page.waitForSelector("table");
await page.screenshot({ path: `${OUT}/08-report.png`, fullPage: true });
const csv = await page.evaluate(async () => {
  const id = location.pathname.split("/")[2];
  const res = await fetch(`/api/events/${id}/report?format=audit.csv`, { headers: { "x-user-email": "jordan@example.com" } });
  return { status: res.status, lines: (await res.text()).split("\r\n").length };
});
console.log(`audit csv: HTTP ${csv.status}, ${csv.lines} lines`);
if (csv.status !== 200 || csv.lines < 5) throw new Error("audit CSV export looks wrong");

} catch (e) {
  await page.screenshot({ path: `${OUT}/failure.png`, fullPage: true }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  console.error(`FAILED: ${e.message}\n--- page text ---\n${text.slice(0, 2000)}\n--- browser errors ---\n${errors.join("\n")}`);
  await browser.close();
  process.exit(1);
}

await browser.close();
if (errors.length > 0) {
  console.error("browser errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log(`ok — screenshots in ${OUT}/`);
