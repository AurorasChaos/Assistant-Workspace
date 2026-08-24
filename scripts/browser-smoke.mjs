import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appRoot = new URL("..", import.meta.url).pathname;
const port = 18000 + (process.pid % 1000);
const bidiPort = port + 1000;
const externalBaseUrl = process.env.REVIEW_SMOKE_BASE_URL?.replace(/\/$/, "");
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(join(tmpdir(), "assistant-workspace-smoke-"));
const profile = join(temporary, "firefox-profile");
const dataRoot = join(temporary, "review-state");
const children = [];

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

async function waitFor(check, label, timeout = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

class Bidi {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === "error") reject(new Error(`${message.error}: ${message.message}`));
      else resolve(message.result);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

let bidi;
try {
  await mkdir(profile, { recursive: true });
  if (!externalBaseUrl) start("node", ["server.mjs"], { cwd: appRoot, env: { ...process.env, REVIEW_PORT: String(port), REVIEW_DATA_ROOT: dataRoot } });
  await waitFor(async () => (await fetch(`${baseUrl}/`)).ok, "review server");

  start("firefox", ["--headless", "--remote-debugging-port", String(bidiPort), "--profile", profile, "about:blank"]);
  await waitFor(async () => {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${bidiPort}/session`);
      await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
      socket.close();
      return true;
    } catch { return false; }
  }, "Firefox BiDi");

  bidi = new Bidi(`ws://127.0.0.1:${bidiPort}/session`);
  await bidi.open();
  await bidi.call("session.new", { capabilities: {} });
  const created = await bidi.call("browsingContext.create", { type: "tab" });
  const context = created.context;
  const evaluate = async (expression) => {
    const response = await bidi.call("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "browser evaluation failed");
    return response.result?.value;
  };

  // The mock frame is sandboxed (opaque origin), so it can no longer be reached
  // through contentDocument. Drive it through its own browsing context instead.
  const frameContext = async () => {
    const tree = await bidi.call("browsingContext.getTree", { root: context });
    const children = tree.contexts?.[0]?.children || [];
    const frame = children.find((child) => (child.url || "").includes("/mocks/"));
    return frame?.context || null;
  };
  const inFrame = async (expression) => {
    const target = await frameContext();
    if (!target) return undefined;
    const response = await bidi.call("script.evaluate", { expression, target: { context: target }, awaitPromise: true, resultOwnership: "none" });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "frame evaluation failed");
    return response.result?.value;
  };

  await bidi.call("browsingContext.navigate", { context, url: `${baseUrl}/groups/example-workspace/reviews/round-1/#mock-dashboard`, wait: "complete" });
  await waitFor(() => evaluate(`document.querySelector('#header-title')?.textContent === 'Coordinator dashboard — round 1'`), "review engine initialization");
  await waitFor(async () => (await inFrame(`document.querySelectorAll('[data-event]').length`)) === 3, "dashboard iframe");
  await waitFor(async () => (await inFrame(`document.documentElement.dataset.demoReady`)) === "true", "dashboard interactions");

  const attentionCount = await inFrame(`(() => { document.querySelector('[data-filter="attention"]').click(); return [...document.querySelectorAll('[data-event]')].filter(x=>!x.hidden).length; })()`);
  if (attentionCount !== 2) throw new Error(`queue filter returned ${attentionCount}, expected 2`);

  await inFrame(`(() => { document.querySelector('[data-event]').click(); document.querySelector('[data-navigate="registration"]').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('#mock-title')?.textContent === 'Guest registration'`), "connected prototype navigation");
  await waitFor(async () => (await inFrame(`document.querySelectorAll('[data-person]').length`)) === 2, "registration iframe");
  await waitFor(async () => (await inFrame(`document.documentElement.dataset.demoReady`)) === "true", "registration interactions");

  // Containment: the sandbox must make the embedding page unreachable from the prototype.
  const reachedParent = await inFrame(`(() => { try { return !!window.parent.document; } catch (error) { return false; } })()`);
  if (reachedParent) throw new Error("sandboxed mock reached the review shell's document");
  const frameOrigin = await inFrame(`window.origin`);
  if (frameOrigin !== "null") throw new Error(`mock frame is not on an opaque origin: ${frameOrigin}`);
  const cookieAccess = await inFrame(`(() => { try { document.cookie; return "readable"; } catch (error) { return error.name; } })()`);
  if (cookieAccess !== "SecurityError") throw new Error(`sandboxed mock could read cookies: ${cookieAccess}`);
  const storageAccess = await inFrame(`(() => { try { localStorage.getItem("x"); return "readable"; } catch (error) { return error.name; } })()`);
  if (storageAccess !== "SecurityError") throw new Error(`sandboxed mock could read local storage: ${storageAccess}`);

  const selectedPerson = await inFrame(`(() => { document.querySelectorAll('[data-person]')[1].click(); return document.querySelector('#selected-person').textContent; })()`);
  if (selectedPerson !== "Alexandra Morgan") throw new Error("guest selection did not update the reservation preview");

  await evaluate(`document.querySelector('#toggle-annotate').click()`);
  await waitFor(async () => (await inFrame(`document.documentElement.classList.contains('review-annotation-mode')`)) === true, "annotation mode reached the sandboxed frame");
  await inFrame(`document.querySelector('[data-review-target="reservation-preview"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#annotation-dialog').open === true`), "annotation dialog through the bridge");
  const dialogTarget = await evaluate(`document.querySelector('#annotation-target-key').textContent`);
  if (dialogTarget !== "reservation-preview") throw new Error(`bridge reported the wrong target: ${dialogTarget}`);
  await evaluate(`(() => { document.querySelector('#annotation-note').value='Keep this consequence preview.'; document.querySelector('#save-annotation').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('#mock-note-count')?.textContent === '1'`), "annotation save");

  await evaluate(`document.querySelector('[data-view="questions"]').click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.question-card').length === 3`), "question rendering");
  await evaluate(`document.querySelector('.question-card input[type="radio"]').click()`);
  const decisionCount = await evaluate(`document.querySelector('#progress-count').textContent`);
  if (!String(decisionCount).startsWith("1 decision")) throw new Error("question decision did not update progress");

  await bidi.call("browsingContext.navigate", { context, url: `${baseUrl}/groups/example-workspace/reviews/final-review/`, wait: "complete" });
  await waitFor(() => evaluate(`document.querySelector('#header-title')?.textContent === 'Community events — Final Review'`), "Final Review initialization");
  await waitFor(() => evaluate(`document.querySelectorAll('[data-view="mock"]').length === 2 && document.querySelectorAll('.settled-decision').length === 3 && document.querySelectorAll('[data-view="artifact"]').length === 2`), "Final Review coverage rendering");
  const finalCoverage = JSON.parse(await evaluate(`JSON.stringify({ mocks: document.querySelectorAll('[data-view="mock"]').length, decisions: document.querySelectorAll('.settled-decision').length, artifacts: document.querySelectorAll('[data-view="artifact"]').length })`));
  if (finalCoverage.mocks !== 2 || finalCoverage.decisions !== 3 || finalCoverage.artifacts !== 2) throw new Error(`Final Review coverage is incomplete: ${JSON.stringify(finalCoverage)}`);
  await evaluate(`document.querySelector('[data-artifact="final-spec"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#artifact-text')?.textContent.includes('final specification')`), "Final Review specification artifact");
  await evaluate(`document.querySelector('[data-artifact="implementation-roadmap"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#artifact-frame')?.contentDocument?.body?.textContent.includes('reusable roadmap artifact v1')`), "reusable roadmap artifact");
  await evaluate(`document.querySelector('[data-mock="round-1-dashboard"]').click()`);
  await waitFor(async () => (await inFrame(`!!document.querySelector('[data-navigate="registration"]')`)) === true, "Final Review source mock");
  await waitFor(async () => (await inFrame(`document.documentElement.dataset.demoReady`)) === "true", "Final Review source interactions");
  await inFrame(`(() => { document.querySelector('[data-event]').click(); document.querySelector('[data-navigate="registration"]').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('#mock-title')?.textContent === 'Round 1 · Guest registration'`), "Final Review connected source navigation");
  await waitFor(async () => (await inFrame(`document.querySelectorAll('[data-person]').length`)) === 2, "Final Review destination mock");
  await waitFor(async () => (await inFrame(`document.documentElement.dataset.demoReady`)) === "true", "Final Review destination interactions");
  await evaluate(`window.postMessage({ type: 'assistant-workspace:navigate', sourceReview: 'round-1', sourceMock: 'dashboard' }, location.origin)`);
  await waitFor(() => evaluate(`document.querySelector('#mock-title')?.textContent === 'Round 1 · Coordinator dashboard'`), "explicit source-round navigation bridge");

  if (process.env.REVIEW_SMOKE_SCREENSHOT) {
    const screenshot = await bidi.call("browsingContext.captureScreenshot", { context, origin: "viewport" });
    await writeFile(resolveOutput(process.env.REVIEW_SMOKE_SCREENSHOT), Buffer.from(screenshot.data, "base64"));
  }

  process.stdout.write("Browser smoke passed: sandboxed prototypes, bridge annotation, containment, questions and complete Final Review coverage.\n");
} finally {
  bidi?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
  await rm(temporary, { recursive: true, force: true });
}

function resolveOutput(path) {
  return path.startsWith("/") ? path : join(process.cwd(), path);
}
