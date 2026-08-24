// Exercises the hosted-facing API surface: index, cache invalidation, live events,
// optimistic concurrency and proxy-supplied capabilities. Runs without a browser.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appRoot = new URL("..", import.meta.url).pathname;
const port = 17000 + (process.pid % 900);
const base = `http://127.0.0.1:${port}`;
const secret = "test-invalidate-secret";
const temporary = await mkdtemp(join(tmpdir(), "assistant-workspace-api-"));
const projectsRoot = join(temporary, "projects");
const stateRoot = join(temporary, "state");
const failures = [];
let child;

const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}\n`);
};

async function waitFor(probe, label, timeout = 10000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}

async function writeProject(id, workspaceId, reviewId) {
  const reviews = join(projectsRoot, id, "reviews", workspaceId, reviewId);
  await mkdir(join(reviews, "mocks"), { recursive: true });
  await writeFile(join(projectsRoot, id, "project.json"), JSON.stringify({ schemaVersion: 1, id, title: id, summary: "api smoke" }));
  await writeFile(join(projectsRoot, id, "reviews", workspaceId, "workspace.json"), JSON.stringify({ schemaVersion: 1, id: workspaceId, title: workspaceId, summary: "api smoke" }));
  await writeFile(join(reviews, "mocks", "mock.css"), ":root { --sandbox-probe: 1 }");
  await writeFile(join(reviews, "mocks", "demo.js"), "window.__demoReady = true; // </script> inside a string must not end the block");
  await writeFile(join(reviews, "mocks", "screen.html"), "<!doctype html><html><head><link rel=\"stylesheet\" href=\"mock.css\"></head><body><section data-review-target='a' data-review-label='A'>a</section><script src=\"demo.js\"></script></body></html>");
  await writeFile(join(reviews, "review.json"), JSON.stringify({
    schemaVersion: 1, id: reviewId, title: `${reviewId} title`, summary: "s", intro: "i",
    mocks: [{ id: "screen", title: "Screen", file: "screen.html" }],
    questions: [{ id: "q1", title: "Q1", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
  }));
}

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const stateUrl = "/projects/alpha/groups/ws/reviews/round-1/api/review";
const blankState = (extra = {}) => ({ version: 0, status: "in_progress", answers: {}, annotations: [], customQuestions: [], overallNotes: "", reviewer: "", ...extra });

try {
  await writeProject("alpha", "ws", "round-1");
  child = spawn("node", ["server.mjs"], {
    cwd: appRoot, stdio: "ignore",
    env: { ...process.env, REVIEW_PORT: String(port), REVIEW_PROJECTS_ROOT: projectsRoot, REVIEW_STATE_ROOT: stateRoot, REVIEW_TRUSTED_PROXY: "1", REVIEW_INVALIDATE_SECRET: secret, REVIEW_INDEX_TTL_MS: "60000" },
  });
  await waitFor(async () => (await fetch(`${base}/`)).ok, "server start");

  process.stdout.write("\n1. index API\n");
  const index = await fetch(`${base}/api/index.json`).then((response) => response.json());
  const workspace = index.projects[0]?.workspaces[0];
  check("index lists the project and workspace", index.projects.length === 1 && workspace?.id === "ws");
  check("index reports rounds and open decisions", workspace?.rounds === 1 && workspace?.openDecisions === 1);
  check("index gives a canonical href", workspace?.href === "projects/alpha/groups/ws/");

  process.stdout.write("\n2. cached discovery and invalidation\n");
  await writeProject("beta", "ws2", "round-1");
  const stale = await fetch(`${base}/api/index.json`).then((response) => response.json());
  check("a TTL cache hides brand-new content until told", stale.projects.length === 1, `${stale.projects.length} project(s)`);
  check("invalidation without the secret is not found", (await post("/internal/invalidate", {})).status === 404);
  check("invalidation with the secret is accepted", (await post("/internal/invalidate", {}, { "x-review-invalidate-secret": secret })).status === 200);
  const fresh = await fetch(`${base}/api/index.json`).then((response) => response.json());
  check("the new project appears after invalidation", fresh.projects.length === 2, `${fresh.projects.length} project(s)`);

  process.stdout.write("\n3. live events\n");
  const events = [];
  const stream = await fetch(`${base}/api/events`);
  const reader = stream.body.getReader();
  const pump = (async () => {
    const decoder = new TextDecoder();
    while (events.length < 1) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) if (line.startsWith("event:")) events.push(line.slice(6).trim());
    }
  })();
  await post("/internal/invalidate", {}, { "x-review-invalidate-secret": secret });
  await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 3000))]);
  check("a publish reaches an open page", events.includes("content-changed"), events.join(",") || "no events");
  await reader.cancel().catch(() => {});

  process.stdout.write("\n4. optimistic concurrency\n");
  const first = await post(stateUrl, { markdown: "# one", state: blankState(), baseVersion: 0 });
  const firstBody = await first.json();
  check("first write is accepted and versioned", first.status === 200 && firstBody.version === 1, `v${firstBody.version}`);
  const stale2 = await post(stateUrl, { markdown: "# stale", state: blankState({ overallNotes: "from a stale page" }), baseVersion: 0 });
  check("a stale write is refused with 409", stale2.status === 409, String(stale2.status));
  const conflictBody = await stale2.json();
  check("the conflict response carries the current state", conflictBody.state?.version === 1);
  const second = await post(stateUrl, { markdown: "# two", state: blankState({ overallNotes: "current" }), baseVersion: 1 });
  check("a current write succeeds", second.status === 200 && (await second.json()).version === 2);

  process.stdout.write("\n5. proxy identity and capabilities\n");
  const readOnly = await post(stateUrl, { markdown: "# x", state: blankState({ overallNotes: "nope" }), baseVersion: 2 }, { "x-review-user": "guest@example.org", "x-review-capabilities": "read" });
  check("read-only access cannot write", readOnly.status === 403 && (await readOnly.json()).error === "read_only");
  const current = await fetch(`${base}/projects/alpha/groups/ws/reviews/round-1/api/state`).then((response) => response.json());
  const guestHeaders = { "x-review-user": "guest@example.org", "x-review-display": "Rachel", "x-review-capabilities": "read,annotate" };
  const guestAnnotates = await post(stateUrl, {
    markdown: "# annotated",
    state: { ...current, annotations: [{ id: "n1", mockId: "screen", targetKey: "a", targetLabel: "A", kind: "change", priority: "should", text: "note", resolved: false }] },
    baseVersion: current.version,
  }, guestHeaders);
  check("a guest may annotate", guestAnnotates.status === 200, String(guestAnnotates.status));
  const annotated = await fetch(`${base}/projects/alpha/groups/ws/reviews/round-1/api/state`).then((response) => response.json());
  check("the annotation is attributed to the guest", annotated.annotations[0]?.author === "Rachel" && annotated.annotations[0]?.authorId === "guest@example.org");
  check("the reviewer name comes from the proxy, not the browser", annotated.reviewer === "Rachel");
  const guestDecides = await post(stateUrl, {
    markdown: "# decided",
    state: { ...annotated, answers: { q1: { selected: "a", status: "decided", notes: "" } } },
    baseVersion: annotated.version,
  }, guestHeaders);
  check("a guest may not record a decision", guestDecides.status === 403 && (await guestDecides.json()).error === "decide_not_permitted");
  const staffDecides = await post(stateUrl, {
    markdown: "# decided",
    state: { ...annotated, answers: { q1: { selected: "a", status: "decided", notes: "" } } },
    baseVersion: annotated.version,
  }, { "x-review-user": "reviewer@example.com", "x-review-display": "A Reviewer", "x-review-capabilities": "read,annotate,decide" });
  check("a named reviewer may record a decision", staffDecides.status === 200, String(staffDecides.status));

  process.stdout.write("\n6. agents propose, humans decide\n");
  const agent = { "x-review-user": "review-agent", "x-review-display": "Review Agent", "x-review-subject-kind": "agent", "x-review-agent-model": "Claude Opus 5", "x-review-capabilities": "read,annotate,decide,complete" };
  const human = { "x-review-user": "aurora@example.com", "x-review-display": "A Reviewer", "x-review-capabilities": "read,annotate,decide,complete" };
  const decider = { "x-review-user": "sam@example.com", "x-review-display": "Sam", "x-review-capabilities": "read,annotate,decide" };

  let live = await fetch(`${base}${stateUrl.replace("/api/review", "/api/state")}`).then((r) => r.json());
  const agentWrites = await post(stateUrl, {
    markdown: "# proposed",
    state: { ...live, answers: { q1: { selected: "a", status: "decided", notes: "", reasoning: "The prototype shows the checkout is fast-forward only." } } },
    baseVersion: live.version,
  }, agent);
  check("an agent may record an answer", agentWrites.status === 200, String(agentWrites.status));
  live = await fetch(`${base}${stateUrl.replace("/api/review", "/api/state")}`).then((r) => r.json());
  check("its answer is stored as a proposal, not a decision", live.answers.q1.status === "proposed", live.answers.q1.status);
  check("the proposal names the agent and its model", live.answers.q1.proposedBy?.kind === "agent" && live.answers.q1.proposedBy?.model === "Claude Opus 5");
  check("an agent does not become the reviewer", live.reviewer !== "Review Agent", `reviewer is ${live.reviewer}`);

  const agentCompletes = await post(stateUrl, { markdown: "# done", state: { ...live, status: "complete" }, baseVersion: live.version }, agent);
  check("an agent may never close a round", agentCompletes.status === 403 && (await agentCompletes.json()).error === "completion_is_human_only");

  const humanCompletesEarly = await post(stateUrl, { markdown: "# done", state: { ...live, status: "complete" }, baseVersion: live.version }, human);
  const earlyBody = await humanCompletesEarly.json();
  check("a round with a proposal outstanding refuses to close", humanCompletesEarly.status === 409 && earlyBody.error === "proposals_outstanding");
  check("the refusal names which questions", Array.isArray(earlyBody.questions) && earlyBody.questions.includes("q1"));

  const confirmed = await post(stateUrl, {
    markdown: "# confirmed",
    state: { ...live, answers: { q1: { ...live.answers.q1, status: "decided" } } },
    baseVersion: live.version,
  }, human);
  check("a person may confirm the proposal", confirmed.status === 200, String(confirmed.status));
  live = await fetch(`${base}${stateUrl.replace("/api/review", "/api/state")}`).then((r) => r.json());
  check("both the proposer and the confirmer are recorded", live.answers.q1.proposedBy?.kind === "agent" && live.answers.q1.confirmedBy?.kind === "human");

  const decideOnly = await post(stateUrl, { markdown: "# done", state: { ...live, status: "complete" }, baseVersion: live.version }, decider);
  check("decide alone cannot close a round", decideOnly.status === 403 && (await decideOnly.json()).error === "complete_not_permitted");

  const closed = await post(stateUrl, { markdown: "# done", state: { ...live, status: "complete" }, baseVersion: live.version }, human);
  check("a person holding complete closes it once nothing is outstanding", closed.status === 200, String(closed.status));

  process.stdout.write("\n7. the narrow propose endpoint\n");
  const proposeUrl = "/projects/alpha/groups/ws/reviews/round-1/api/propose";
  live = await fetch(`${base}${stateUrl.replace("/api/review", "/api/state")}`).then((r) => r.json());
  const proposed = await post(proposeUrl, { questionId: "q1", selected: "b", reasoning: "Because the round said so.", baseVersion: live.version }, agent);
  check("an agent proposes with one call and no markdown", proposed.status === 200, String(proposed.status));
  check("the endpoint reports it as a proposal", (await proposed.json()).status === "proposed");
  const badOption = await post(proposeUrl, { questionId: "q1", selected: "not-an-option", baseVersion: live.version + 1 }, agent);
  check("an option that does not exist is refused", badOption.status === 422 && (await badOption.json()).error === "unknown_option");
  const badQuestion = await post(proposeUrl, { questionId: "nope", selected: "a", baseVersion: live.version + 1 }, agent);
  check("a question that does not exist is refused", badQuestion.status === 404);
  const staleWrite = await post(proposeUrl, { questionId: "q1", selected: "a", baseVersion: 0 }, agent);
  check("a stale proposal is refused rather than merged away", staleWrite.status === 409);
  const guestPropose = await post(proposeUrl, { questionId: "q1", selected: "a" }, { "x-review-user": "g@example.org", "x-review-capabilities": "read,annotate" });
  check("annotate alone cannot propose", guestPropose.status === 403);

  process.stdout.write("\n6. state root override\n");
  const { access } = await import("node:fs/promises");
  const overridden = await access(join(stateRoot, "alpha", "ws", "round-1", "state.json")).then(() => true, () => false);
  check("state is written under REVIEW_STATE_ROOT, not beside the content", overridden);
  const beside = await access(join(projectsRoot, "alpha", "state")).then(() => true, () => false);
  check("nothing is written into the content checkout", !beside);

  process.stdout.write("\n7. bridge injection\n");
  const mockHtml = await fetch(`${base}/projects/alpha/groups/ws/reviews/round-1/mocks/screen/screen.html`).then((response) => response.text());
  check("every mock document carries the annotation bridge", mockHtml.includes("data-assistant-workspace-bridge"));
  check("same-directory stylesheets are inlined", mockHtml.includes("data-inlined-from=\"mock.css\"") && mockHtml.includes("--sandbox-probe"));
  check("the original link tag is gone", !/<link[^>]*stylesheet/i.test(mockHtml));
  check("same-directory scripts are inlined too", mockHtml.includes('data-inlined-from="demo.js"') && mockHtml.includes("__demoReady"));
  check("no external script tag survives", !/<script[^>]*\bsrc=/i.test(mockHtml));
  check("a closing tag inside the script is escaped", mockHtml.includes("<\\/script"));
  check("the bridge is injected once", (mockHtml.match(/data-assistant-workspace-bridge/g) || []).length === 1);
} finally {
  child?.kill("SIGKILL");
  await rm(temporary, { recursive: true, force: true });
}

if (failures.length) {
  process.stderr.write(`\nAPI smoke failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\nAPI smoke passed: index, invalidation, live events, concurrency, capabilities and bridge injection.\n");
}
