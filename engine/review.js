let pack;
let state;
let currentView = "overview";
let currentMock = "";
let currentArtifact = "";
let annotationMode = false;
let selectedTarget = null;
let saveTimer;
let toastTimer;
let conflict = false;
let conflictState = null;
let liveStream = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const nowIso = () => new Date().toISOString();
const storageKey = () => `assistant-workspace:${pack.project?.id || "shared"}:${pack.workspace.id}:${pack.id}:state`;
const appBase = () => location.pathname.match(/^(.*?)\/groups\/[^/]+\/reviews\/[^/]+\//)?.[1] || "";
const appUrl = (path = "") => `${appBase()}/${String(path).replace(/^\/+/, "")}`;
// The engine's own root, above /projects/<id>, so a path-mounted deployment still
// resolves the global endpoints.
const siteRoot = () => appBase().replace(/\/projects\/[^/]+$/, "");
const frameWindow = () => $("#mock-frame")?.contentWindow || null;

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function blankState() {
  return { schema: 1, version: 0, status: "in_progress", startedAt: nowIso(), updatedAt: nowIso(), completedAt: null, reviewer: "", overallNotes: "", answers: {}, annotations: [], customQuestions: [] };
}

function normalizeState(input) {
  const base = blankState();
  if (!input || typeof input !== "object") return base;
  return { ...base, ...input, answers: input.answers && typeof input.answers === "object" ? input.answers : {}, annotations: Array.isArray(input.annotations) ? input.annotations : [], customQuestions: Array.isArray(input.customQuestions) ? input.customQuestions : [] };
}

function answerFor(id) {
  return state.answers[id] || { selected: "", notes: "", status: "unresolved" };
}

function counts() {
  const answers = pack.questions.map((question) => answerFor(question.id));
  return { decided: answers.filter((answer) => answer.status === "decided").length, deferred: answers.filter((answer) => answer.status === "deferred").length, open: answers.filter((answer) => answer.status === "unresolved").length, notes: state.annotations.length, openNotes: state.annotations.filter((note) => !note.resolved).length };
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2500);
}

function updateSummary() {
  const result = counts();
  $("#progress-label").textContent = state.status === "complete" ? "Review complete" : "Review in progress";
  $("#progress-count").textContent = `${result.decided} decisions · ${result.notes} notes`;
  $("#progress-bar").style.width = `${Math.round(result.decided / Math.max(1, pack.questions.length) * 100)}%`;
  $("#complete-review").textContent = state.status === "complete" ? "Reopen review" : "Mark complete";
  for (const mock of pack.mocks) {
    const badge = $(`[data-count-for="${CSS.escape(mock.id)}"]`);
    if (badge) badge.textContent = state.annotations.filter((note) => note.mockId === mock.id).length;
  }
  const questionBadge = $("#questions-badge");
  if (questionBadge) questionBadge.textContent = result.open + result.deferred;
  const summary = $("#summary-values");
  if (summary) summary.innerHTML = `<div class="summary-stat"><span>Annotations</span><b>${result.notes}</b></div><div class="summary-stat"><span>Decisions</span><b>${result.decided} / ${pack.questions.length}</b></div><div class="summary-stat"><span>Deferred</span><b>${result.deferred}</b></div><div class="summary-stat"><span>Unanswered</span><b>${result.open}</b></div>`;
}

function markDirty() {
  state.updatedAt = nowIso();
  localStorage.setItem(storageKey(), JSON.stringify(state));
  $("#save-status").textContent = "Saving…";
  updateSummary();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(false), 450);
}

async function save(showToast = true) {
  localStorage.setItem(storageKey(), JSON.stringify(state));
  if (pack.staticDemo) {
    $("#save-status").textContent = "Saved in browser";
    $("#storage-mode").textContent = "Public demo · browser storage + Markdown download";
    if (showToast) toast("Saved in this browser");
    return false;
  }
  if (conflict) { $("#save-status").textContent = "Paused — conflict"; return false; }
  try {
    const response = await fetch("api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, markdown: compileMarkdown(), baseVersion: Number(state.version || 0) }) });
    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      showConflict(body.state || null);
      return false;
    }
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      $("#save-status").textContent = body.error === "decide_not_permitted" ? "Not permitted to decide" : "Read-only access";
      toast(body.error === "decide_not_permitted" ? "Your access allows annotations, not decisions" : "Your access is read-only");
      return false;
    }
    if (!response.ok) throw new Error(String(response.status));
    const saved = await response.json().catch(() => ({}));
    if (saved.version) state.version = saved.version;
    $("#save-status").textContent = "Saved";
    $("#storage-mode").textContent = "Server file + browser fallback";
    if (showToast) toast("Review saved");
    return true;
  } catch {
    $("#save-status").textContent = "Saved in browser";
    $("#storage-mode").textContent = "Browser only; run the server to create handoff files";
    if (showToast) toast("Saved in this browser");
    return false;
  }
}

function showConflict(latest) {
  conflict = true;
  conflictState = latest;
  clearTimeout(saveTimer);
  $("#save-status").textContent = "Paused — conflict";
  const banner = $("#conflict-banner");
  if (!banner) return;
  banner.hidden = false;
  const who = latest?.reviewer ? ` by ${latest.reviewer}` : "";
  const when = latest?.updatedAt ? new Date(latest.updatedAt).toLocaleTimeString("en-GB") : "";
  $("#conflict-detail").textContent = `This review was saved${who}${when ? ` at ${when}` : ""} while you were working. Your changes are still in this browser and have not been sent.`;
}

function clearConflict() {
  conflict = false;
  conflictState = null;
  const banner = $("#conflict-banner");
  if (banner) banner.hidden = true;
}

function renderAll() {
  renderNav();
  renderOverview();
  renderQuestions();
  renderNotes();
  updateSummary();
}

function renderNav() {
  const mockButtons = pack.mocks.map((mock, index) => `<button class="nav-item" data-view="mock" data-mock="${escapeHtml(mock.id)}" type="button"><span>${String(index + 2).padStart(2, "0")}</span><b>${escapeHtml(mock.shortTitle || mock.title)}</b><em data-count-for="${escapeHtml(mock.id)}">0</em></button>`).join("");
  const artifactButtons = (pack.artifacts || []).map((artifact, index) => `<button class="nav-item" data-view="artifact" data-artifact="${escapeHtml(artifact.id)}" type="button"><span>${String(pack.mocks.length + index + 2).padStart(2, "0")}</span><b>${escapeHtml(artifact.shortTitle || artifact.title)}</b></button>`).join("");
  const artifactSection = artifactButtons ? `<span class="nav-label">Artifacts</span>${artifactButtons}` : "";
  const decisionNumber = pack.mocks.length + (pack.artifacts?.length || 0) + 2;
  $("#review-nav").innerHTML = `<span class="nav-label">Review</span><button class="nav-item active" data-view="overview" type="button"><span>01</span><b>Start here</b></button><span class="nav-label">Prototype</span>${mockButtons}${artifactSection}<span class="nav-label">Decisions</span><button class="nav-item" data-view="questions" type="button"><span>${String(decisionNumber).padStart(2, "0")}</span><b>Questions</b><em id="questions-badge">0</em></button><button class="nav-item" data-view="compiled" type="button"><span>${String(decisionNumber + 1).padStart(2, "0")}</span><b>Compiled review</b></button>`;
}

function renderOverview() {
  const principles = (pack.principles || []).map((principle, index) => `<article class="principle"><span>${String(index + 1).padStart(2, "0")}</span><h3>${escapeHtml(principle.title)}</h3><p>${escapeHtml(principle.detail)}</p></article>`).join("");
  const decisions = (pack.decisions || []).map((decision) => `<div class="settled-decision"><b>${escapeHtml(decision.title)}</b><span>${escapeHtml(decision.outcome)}</span></div>`).join("");
  const register = decisions ? `<section class="decision-register"><span class="kicker">Consolidated record</span><h2>Settled decisions</h2>${decisions}</section>` : "";
  $("#view-overview").innerHTML = `<div class="intro-grid"><article class="intro-copy"><span class="kicker">${escapeHtml(pack.stage || "Design review")}</span><h1>${escapeHtml(pack.heading || pack.title)}</h1><p>${escapeHtml(pack.intro || pack.summary)}</p><div class="notice"><b>Build gate:</b> completing this review records decisions only. It does not authorize product implementation.</div><ol><li>Use the prototype normally first. Its controls should demonstrate the connected flow.</li><li>Turn on annotation mode when you want to mark a specific region.</li><li>Answer the authored questions or add your own view.</li><li>Mark complete to create a Markdown handoff.</li></ol>${register}</article><aside class="summary-panel"><h2>Review state</h2><div id="summary-values"></div><label class="field">Reviewer<input id="reviewer" class="input" value="${escapeHtml(state.reviewer)}" placeholder="Optional name"></label><label class="field">Overall direction<textarea id="overall-notes" class="input" rows="5" placeholder="Context that should guide the whole review…">${escapeHtml(state.overallNotes)}</textarea></label></aside></div><div class="principles">${principles}</div>`;
  $("#reviewer").addEventListener("input", (event) => { state.reviewer = event.target.value; markDirty(); });
  $("#overall-notes").addEventListener("input", (event) => { state.overallNotes = event.target.value; markDirty(); });
  updateSummary();
}

function switchView(view, mockId) {
  currentView = view;
  if (mockId) currentMock = mockId;
  if (view === "artifact" && mockId) currentArtifact = mockId;
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view && (view !== "mock" || button.dataset.mock === currentMock) && (view !== "artifact" || button.dataset.artifact === currentArtifact)));
  const hash = view === "mock" ? `#mock-${currentMock}` : view === "artifact" ? `#artifact-${currentArtifact}` : `#${view}`;
  history.replaceState(null, "", hash);
  if (view === "mock") loadMock(currentMock);
  if (view === "artifact") void loadArtifact(currentArtifact);
  if (view === "questions") renderQuestions();
  if (view === "compiled") $("#compiled-output").textContent = compileMarkdown();
}

function loadMock(id) {
  const mock = pack.mocks.find((item) => item.id === id) || pack.mocks[0];
  currentMock = mock.id;
  $("#mock-title").textContent = mock.title;
  $("#mock-description").textContent = mock.description || "";
  const frame = $("#mock-frame");
  const expected = new URL(`mocks/${encodeURIComponent(mock.id)}/${mock.file}`, location.href).href;
  if (frame.src !== expected) frame.src = expected;
  renderNotes();
}

async function loadArtifact(id) {
  const artifact = (pack.artifacts || []).find((item) => item.id === id) || pack.artifacts?.[0];
  if (!artifact) return;
  currentArtifact = artifact.id;
  $("#artifact-title").textContent = artifact.title;
  $("#artifact-description").textContent = artifact.description || "";
  const url = `artifacts/${encodeURIComponent(artifact.id)}`;
  $("#open-artifact").dataset.url = url;
  if (artifact.format === "markdown" || artifact.format === "text") {
    $("#artifact-frame").hidden = true;
    $("#artifact-text").hidden = false;
    $("#artifact-text").textContent = await fetch(url).then((response) => response.text());
  } else {
    $("#artifact-text").hidden = true;
    $("#artifact-frame").hidden = false;
    $("#artifact-frame").src = url;
  }
}

// The mock frame is sandboxed, so annotation is a message protocol rather than
// DOM access. The bridge is injected into every mock document by the server.
function toFrame(message) {
  frameWindow()?.postMessage(message, "*");
}

function setAnnotationMode(on) {
  annotationMode = on;
  $("#toggle-annotate").classList.toggle("on", on);
  $("#annotation-help").hidden = !on;
  toFrame({ type: "assistant-workspace:annotation-mode", on });
}

function greetFrame() {
  toFrame({ type: "assistant-workspace:hello", origin: location.origin });
  toFrame({ type: "assistant-workspace:annotation-mode", on: annotationMode });
}

function openAnnotationDialog(key, label) {
  selectedTarget = { key, label: label || key };
  $("#annotation-target-label").textContent = selectedTarget.label;
  $("#annotation-target-key").textContent = selectedTarget.key;
  $("#annotation-note").value = "";
  $("#annotation-dialog").showModal();
}

function bindFrame() {
  $("#mock-frame").addEventListener("load", () => greetFrame());
}

function renderNotes() {
  const notes = state.annotations.filter((note) => note.mockId === currentMock);
  $("#mock-note-count").textContent = notes.length;
  $("#mock-notes").innerHTML = notes.length ? notes.map((note) => `<article class="note ${note.resolved ? "resolved" : ""}" data-note-id="${escapeHtml(note.id)}"><header><span>${escapeHtml(note.kind)} · ${escapeHtml(note.priority)}</span><span>${note.resolved ? "Resolved" : "Open"}</span></header><b>${escapeHtml(note.targetLabel)}</b><p>${escapeHtml(note.text)}</p><button type="button" data-note-action="toggle">${note.resolved ? "Reopen" : "Resolve"}</button></article>`).join("") : "<p>No annotations on this screen yet.</p>";
}

function renderQuestions() {
  $("#questions-list").innerHTML = pack.questions.map((question, index) => {
    const answer = answerFor(question.id);
    const options = [...question.options, { id: "own-view", label: "My own view", detail: "Use the notes field to describe a different direction." }].map((option) => `<label class="option"><input type="radio" name="q-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}" ${answer.selected === option.id ? "checked" : ""}><b>${escapeHtml(option.label)}</b><p>${escapeHtml(option.detail || "")}</p></label>`).join("");
    return `<article class="question-card" data-question="${escapeHtml(question.id)}"><div class="question-head"><div><span class="kicker">Decision ${String(index + 1).padStart(2, "0")}</span><h2>${escapeHtml(question.title)}</h2><p>${escapeHtml(question.prompt || "")}</p></div><span class="question-state">${escapeHtml(answer.status)}</span></div>${question.recommendation ? `<div class="recommendation"><b>Recommendation:</b> ${escapeHtml(question.recommendation)}</div>` : ""}<div class="options">${options}</div><div class="answer-grid"><select class="input" data-answer-status><option value="unresolved" ${answer.status === "unresolved" ? "selected" : ""}>Unresolved</option><option value="decided" ${answer.status === "decided" ? "selected" : ""}>Decided</option><option value="deferred" ${answer.status === "deferred" ? "selected" : ""}>Defer</option></select><textarea class="input" data-answer-notes rows="3" placeholder="Details, conditions or your own view…">${escapeHtml(answer.notes)}</textarea></div></article>`;
  }).join("");
}

function selectedOption(question, answer) {
  if (answer.selected === "own-view") return "My own view";
  return question.options.find((option) => option.id === answer.selected)?.label || "No option selected";
}

function compileMarkdown() {
  const result = counts();
  const lines = [`# ${pack.title} — review`, "", `- Workspace: ${pack.workspace.title}`, `- Review: ${pack.id}`, `- Status: ${state.status}`, `- Reviewer: ${state.reviewer || "Not provided"}`, `- Updated: ${state.updatedAt}`, `- Decisions: ${result.decided}/${pack.questions.length}`, `- Deferred: ${result.deferred}`, `- Open annotations: ${result.openNotes}`, "", "## Overall direction", "", state.overallNotes || "No overall notes provided.", "", "## Decisions", ""];
  for (const question of pack.questions) {
    const answer = answerFor(question.id);
    lines.push(`### ${question.title}`, "", `- Status: ${answer.status}`, `- Selection: ${selectedOption(question, answer)}`, `- Recommendation: ${question.recommendation || "None"}`, "", answer.notes || "No additional detail.", "");
  }
  lines.push("## Mockup annotations", "");
  if (!state.annotations.length) lines.push("No annotations.", "");
  for (const note of state.annotations) {
    const mock = pack.mocks.find((item) => item.id === note.mockId);
    lines.push(`### ${mock?.title || note.mockId}: ${note.targetLabel}`, "", `- Type: ${note.kind}`, `- Priority: ${note.priority}`, `- Status: ${note.resolved ? "resolved" : "open"}`, `- Target: ${note.targetKey}`, "", note.text, "");
  }
  if (state.customQuestions.length) {
    lines.push("## Reviewer-added decisions", "");
    for (const item of state.customQuestions) lines.push(`### ${item.title}`, "", item.detail || "No detail.", "");
  }
  if (pack.decisions?.length) {
    lines.push("## Consolidated settled decisions", "");
    for (const decision of pack.decisions) lines.push(`- **${decision.title}:** ${decision.outcome} (${decision.sourceReview || "source not recorded"}${decision.sourceQuestion ? ` / ${decision.sourceQuestion}` : ""})`);
    lines.push("");
  }
  lines.push("## Handoff gate", "", state.status === "complete" ? (pack.handoff?.complete || "Review complete. Ask explicitly before implementation.") : (pack.handoff?.inProgress || "Review remains in progress."), "");
  return lines.join("\n");
}

function download(filename, contents, type = "text/markdown") {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([contents], { type }));
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function bindEvents() {
  $("#review-nav").addEventListener("click", (event) => { const button = event.target.closest("[data-view]"); if (button) switchView(button.dataset.view, button.dataset.mock || button.dataset.artifact); });
  $("#save-now").addEventListener("click", () => void save());
  $("#download-review").addEventListener("click", () => download(`${pack.workspace.id}-${pack.id}-review.md`, compileMarkdown()));
  $("#download-compiled").addEventListener("click", () => download(`${pack.workspace.id}-${pack.id}-review.md`, compileMarkdown()));
  $("#copy-compiled").addEventListener("click", async () => { await navigator.clipboard.writeText(compileMarkdown()); toast("Copied Markdown"); });
  $("#toggle-annotate").addEventListener("click", () => setAnnotationMode(!annotationMode));
  $("#fit-mock").addEventListener("click", () => $(".frame-shell").classList.toggle("fit"));
  $("#open-mock").addEventListener("click", () => window.open($("#mock-frame").src, "_blank", "noopener"));
  $("#open-artifact").addEventListener("click", (event) => window.open(event.currentTarget.dataset.url, "_blank", "noopener"));
  $("#complete-review").addEventListener("click", () => {
    if (state.status === "complete") { state.status = "in_progress"; state.completedAt = null; markDirty(); return; }
    const result = counts();
    const warning = result.open || result.deferred || result.openNotes ? `There are ${result.open} unanswered, ${result.deferred} deferred and ${result.openNotes} open annotations. Mark complete anyway?` : "Mark this review complete? This still does not authorize a build.";
    if (!confirm(warning)) return;
    state.status = "complete"; state.completedAt = nowIso(); markDirty(); void save();
  });
  $("#annotation-form").addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel" || !selectedTarget) return;
    const text = $("#annotation-note").value.trim();
    if (!text) { event.preventDefault(); return; }
    state.annotations.push({ id: crypto.randomUUID(), mockId: currentMock, targetKey: selectedTarget.key, targetLabel: selectedTarget.label, kind: $("#annotation-kind").value, priority: $("#annotation-priority").value, text, resolved: false, createdAt: nowIso() });
    markDirty(); renderNotes(); selectedTarget = null; setAnnotationMode(false);
  });
  $("#mock-notes").addEventListener("click", (event) => {
    const article = event.target.closest("[data-note-id]");
    if (!article || !event.target.matches("[data-note-action]")) return;
    const note = state.annotations.find((item) => item.id === article.dataset.noteId);
    if (note) { note.resolved = !note.resolved; markDirty(); renderNotes(); }
  });
  $("#questions-list").addEventListener("change", (event) => {
    const card = event.target.closest("[data-question]"); if (!card) return;
    const answer = answerFor(card.dataset.question);
    if (event.target.matches('input[type="radio"]')) { answer.selected = event.target.value; if (answer.status === "unresolved") answer.status = "decided"; }
    if (event.target.matches("[data-answer-status]")) answer.status = event.target.value;
    state.answers[card.dataset.question] = answer; markDirty(); renderQuestions();
  });
  $("#questions-list").addEventListener("input", (event) => {
    if (!event.target.matches("[data-answer-notes]")) return;
    const card = event.target.closest("[data-question]"); const answer = answerFor(card.dataset.question); answer.notes = event.target.value; state.answers[card.dataset.question] = answer; markDirty();
  });
  $("#add-custom").addEventListener("click", () => {
    const title = $("#custom-title").value.trim(); const detail = $("#custom-detail").value.trim();
    if (!title) { toast("Add a title first"); return; }
    state.customQuestions.push({ id: crypto.randomUUID(), title, detail, createdAt: nowIso() }); $("#custom-title").value = ""; $("#custom-detail").value = ""; markDirty(); toast("Added to the compiled review");
  });
  window.addEventListener("message", (event) => {
    // A sandboxed frame reports its origin as "null", so identity is established by
    // the source window rather than by an origin string. Same-origin messages from
    // the shell's own window keep working, which is the documented embedding path.
    const fromFrame = event.source === frameWindow();
    const fromSelf = event.source === window && event.origin === location.origin;
    if (!fromFrame && !fromSelf) return;
    const type = event.data?.type;
    if (type === "assistant-workspace:ready") { greetFrame(); return; }
    if (type === "assistant-workspace:annotate-miss") { toast("Choose a labelled region in the prototype"); return; }
    if (type === "assistant-workspace:annotate-target") {
      openAnnotationDialog(event.data.key, event.data.label);
      return;
    }
    if (type !== "assistant-workspace:navigate") return;
    const direct = pack.mocks.find((mock) => mock.id === event.data.mockId);
    const exactSource = event.data.sourceReview && event.data.sourceMock
      ? pack.mocks.find((mock) => mock.sourceReview === event.data.sourceReview && mock.sourceMock === event.data.sourceMock)
      : null;
    const currentSource = pack.mocks.find((mock) => mock.id === currentMock)?.sourceReview;
    const sourced = pack.mocks.find((mock) => mock.sourceReview === currentSource && mock.sourceMock === event.data.mockId);
    const target = direct || exactSource || sourced;
    if (target) switchView("mock", target.id);
    else if (event.data.sourceReview && event.data.sourceMock) {
      location.href = `${appUrl(`groups/${encodeURIComponent(pack.workspace.id)}/reviews/${encodeURIComponent(event.data.sourceReview)}/`)}#mock-${encodeURIComponent(event.data.sourceMock)}`;
    }
  });
  $("#conflict-reload")?.addEventListener("click", () => {
    if (!conflictState) { location.reload(); return; }
    state = normalizeState(conflictState);
    clearConflict();
    renderAll();
    switchView(currentView, currentView === "mock" ? currentMock : currentArtifact);
    toast("Loaded the saved review");
  });
  $("#conflict-overwrite")?.addEventListener("click", () => {
    if (conflictState) state.version = Number(conflictState.version || 0);
    clearConflict();
    void save();
  });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && annotationMode) setAnnotationMode(false); });
}

/** New rounds published while this page is open. Never reloads under someone's hands. */
function subscribeLive() {
  if (pack.staticDemo || typeof EventSource === "undefined" || liveStream) return;
  try {
    liveStream = new EventSource(`${siteRoot()}/api/events`);
    liveStream.addEventListener("content-changed", () => toast("New content published — reload to see it"));
  } catch { liveStream = null; }
}

async function init() {
  pack = await fetch("review.json").then((response) => { if (!response.ok) throw new Error("Review manifest could not be loaded"); return response.json(); });
  document.title = `${pack.title} · Assistant Workspace`;
  $("#header-title").textContent = pack.title;
  $("#workspace-link").href = appUrl(`groups/${encodeURIComponent(pack.workspace.id)}/`);
  let serverState = null;
  if (!pack.staticDemo) try { const response = await fetch("api/state"); if (response.ok && response.status !== 204) serverState = await response.json(); } catch {}
  let localState = null;
  try { localState = JSON.parse(localStorage.getItem(storageKey())); } catch {}
  state = normalizeState(serverState || localState);
  currentMock = pack.mocks[0]?.id || "";
  currentArtifact = pack.artifacts?.[0]?.id || "";
  renderNav(); renderOverview(); renderQuestions(); bindEvents(); bindFrame(); updateSummary();
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("mock-") && pack.mocks.some((mock) => mock.id === hash.slice(5))) switchView("mock", hash.slice(5));
  else if (hash.startsWith("artifact-") && (pack.artifacts || []).some((artifact) => artifact.id === hash.slice(9))) switchView("artifact", hash.slice(9));
  else if (["questions", "compiled"].includes(hash)) switchView(hash);
  else switchView("overview");
  subscribeLive();
  $("#save-status").textContent = serverState ? "Loaded saved review" : "Ready";
  $("#storage-mode").textContent = pack.staticDemo ? "Public demo · browser storage + Markdown download" : "Server file + browser fallback";
}

init().catch((error) => { document.body.innerHTML = `<main style="padding:40px;color:white;font-family:system-ui"><h1>Review could not start</h1><p>${escapeHtml(error.message)}</p></main>`; });
