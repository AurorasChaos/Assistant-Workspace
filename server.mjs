import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryStateLabels, deliveryStateOf, deliveryStates, renderRoadmap, roadmapCounts } from "./lib/roadmap.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const contentRoot = resolve(process.env.REVIEW_CONTENT_ROOT || join(appRoot, "reviews"));
const dataRoot = resolve(process.env.REVIEW_DATA_ROOT || join(appRoot, ".review-data"));
const projectsRoot = process.env.REVIEW_PROJECTS_ROOT ? resolve(process.env.REVIEW_PROJECTS_ROOT) : null;
const host = process.env.REVIEW_HOST || "127.0.0.1";
const port = Number(process.env.REVIEW_PORT || process.argv[2] || 8777);
const maxBodyBytes = 2 * 1024 * 1024;
// Hosted deployments put an authenticating proxy in front and cache the index.
// Both default off so a workstation keeps today's behaviour exactly: no trusted
// headers, and content re-read from disk on every single request.
const trustedProxy = process.env.REVIEW_TRUSTED_PROXY === "1";
const indexTtlMs = Math.max(0, Number(process.env.REVIEW_INDEX_TTL_MS || 0));
const invalidateSecret = process.env.REVIEW_INVALIDATE_SECRET || "";
// Hosted deployments keep reviewer state on its own writable volume, away from the
// content checkout. Setting this overrides every project's `stateRoot`, so a shared
// content repository never has to carry a host-specific absolute path.
const stateRootOverride = process.env.REVIEW_STATE_ROOT ? resolve(process.env.REVIEW_STATE_ROOT) : null;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function send(response, status, body = "", contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  });
  response.end(body);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

async function writeAtomic(target, contents) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, target);
}

async function optionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

let cachedProjects = null;
let cachedProjectsAt = 0;
const eventClients = new Set();

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try { client.write(payload); } catch { eventClients.delete(client); }
  }
}

/** Drop the cached index and tell open pages. Called by the publisher and by our own writes. */
function invalidateIndex(reason, event = "content-changed") {
  cachedProjects = null;
  cachedProjectsAt = 0;
  broadcast(event, { reason });
}

/** Discovery with an optional TTL. With no TTL configured this is a plain disk read. */
/** A static map of the nine roadmap artifact URLs that existed before the move. */
const roadmapRedirects = new Map(Object.entries(
  await optionalJson(join(appRoot, "engine", "redirects.json")) || {},
));

async function getProjects() {
  if (indexTtlMs > 0 && cachedProjects && Date.now() - cachedProjectsAt < indexTtlMs) return cachedProjects;
  const projects = await discoverProjects();
  if (indexTtlMs > 0) {
    cachedProjects = projects;
    cachedProjectsAt = Date.now();
  }
  return projects;
}

/** Verified identity from the trusted proxy, or null when unproxied. */
function identityFrom(request) {
  if (!trustedProxy) return null;
  const user = request.headers["x-review-user"];
  if (typeof user !== "string" || !user) return null;
  const raw = request.headers["x-review-capabilities"];
  const capabilities = String(typeof raw === "string" ? raw : "read").split(",").map((value) => value.trim()).filter(Boolean);
  // A machine may record decisions and may never close a round. The proxy caps
  // capability already; this is the second place that refuses, because one layer
  // is how a rule like this quietly stops holding.
  const kind = request.headers["x-review-subject-kind"] === "agent" ? "agent" : "human";
  return {
    user,
    display: typeof request.headers["x-review-display"] === "string" ? request.headers["x-review-display"] : user,
    capabilities: kind === "agent" ? capabilities.filter((value) => value !== "complete") : capabilities,
    kind,
    model: typeof request.headers["x-review-agent-model"] === "string" ? request.headers["x-review-agent-model"] : null,
  };
}

/** What `decide` governs: the answers themselves. */
function decisionFingerprint(state) {
  return JSON.stringify({
    answers: state?.answers || {},
    overallNotes: state?.overallNotes || "",
    customQuestions: state?.customQuestions || [],
  });
}

/** What `complete` governs: declaring the round settled. Deliberately separate —
 *  recording a decision and closing a round are different acts, and an agent may
 *  do the first and never the second. */
function completionFingerprint(state) {
  return JSON.stringify({ status: state?.status || "in_progress" });
}

/**
 * Record who wrote each answer, and who agreed with it.
 *
 * An answer carried no authorship before this existed, so one without it reads as
 * a human decision — which is what every one of them was.
 */
function stampAnswerAuthorship(previousAnswers, nextAnswers, identity) {
  const previous = previousAnswers || {};
  const result = {};
  for (const [id, answer] of Object.entries(nextAnswers || {})) {
    if (!answer || typeof answer !== "object") { result[id] = answer; continue; }
    const before = previous[id];
    const unchanged = before && JSON.stringify({ ...before, proposedBy: null, confirmedBy: null })
      === JSON.stringify({ ...answer, proposedBy: null, confirmedBy: null });
    if (unchanged) { result[id] = { ...before, ...answer }; continue; }

    const stamp = { id: identity.user, display: identity.display, kind: identity.kind, at: new Date().toISOString(), ...(identity.model ? { model: identity.model } : {}) };
    if (identity.kind === "agent") {
      // An agent proposes. It never records agreement, its own or anyone else's.
      result[id] = { ...answer, status: "proposed", proposedBy: stamp, confirmedBy: null };
    } else {
      // A person answering a proposal is agreeing with it or replacing it; either
      // way the proposal stays visible in the record.
      result[id] = { ...answer, status: answer.status === "proposed" ? "decided" : answer.status, proposedBy: before?.proposedBy ?? answer.proposedBy ?? null, confirmedBy: stamp };
    }
  }
  return result;
}

/** Answers an agent has proposed and nobody has agreed with yet. */
function outstandingProposals(state) {
  return Object.entries(state?.answers || {})
    .filter(([, answer]) => answer?.status === "proposed")
    .map(([id]) => id);
}

async function discoverProjects() {
  if (!projectsRoot) {
    return [{
      id: "shared",
      title: "Shared",
      summary: "Workspaces in the configured content root.",
      legacy: true,
      contentRoot,
      dataRoot,
      workspaces: await discoverWorkspaces({ id: "shared", contentRoot, dataRoot }),
    }];
  }

  const projects = [];
  let entries = [];
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const directory = join(projectsRoot, entry.name);
    const manifest = await optionalJson(join(directory, "project.json"));
    if (!manifest || manifest.id !== entry.name) continue;
    const projectContentRoot = resolve(directory, manifest.contentRoot || "reviews");
    const projectDataRoot = stateRootOverride
      ? join(stateRootOverride, entry.name)
      : resolve(directory, manifest.stateRoot || "state");
    const project = {
      id: entry.name,
      title: manifest.title || entry.name,
      summary: manifest.summary || "Project-owned Assistant Workspace namespace.",
      order: Number(manifest.order || 0),
      legacy: false,
      directory,
      contentRoot: projectContentRoot,
      dataRoot: projectDataRoot,
    };
    projects.push({ ...project, workspaces: await discoverWorkspaces(project) });
  }
  return projects.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

async function discoverWorkspaces(project) {
  const workspaces = [];
  let entries = [];
  try {
    entries = await readdir(project.contentRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const directory = join(project.contentRoot, entry.name);
    const manifest = await optionalJson(join(directory, "workspace.json"));
    if (!manifest || manifest.id !== entry.name) continue;
    const reviews = await discoverReviews(project, entry.name, directory);
    const roadmap = await optionalJson(join(directory, "roadmap.json"));
    workspaces.push({ ...manifest, directory, reviews, roadmap, projectId: project.id });
  }
  return workspaces.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

async function discoverReviews(project, workspaceId, workspaceDirectory) {
  const reviews = [];
  const entries = await readdir(workspaceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const directory = join(workspaceDirectory, entry.name);
    const manifest = await optionalJson(join(directory, "review.json"));
    if (!manifest || manifest.id !== entry.name) continue;
    const stateDirectory = join(project.dataRoot, workspaceId, entry.name);
    const state = await optionalJson(join(stateDirectory, "state.json"));
    reviews.push({ ...manifest, directory, stateDirectory, state });
  }
  return reviews.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

/**
 * A workspace with no roadmap is still a workspace: it reports as designing from
 * its manifest and round list alone, so nothing has to explain a gap.
 */
function deliveryFacts(workspace) {
  const roadmap = workspace.roadmap;
  const counts = roadmap ? roadmapCounts(roadmap) : { lanes: 0, phases: 0, outcomes: 0, integrated: 0, commits: 0 };
  const state = roadmap ? deliveryStateOf(roadmap) : "designing";
  const completions = workspace.reviews
    .filter((review) => review.state?.status === "complete" && review.state?.updatedAt)
    .map((review) => review.state.updatedAt)
    .sort();
  const activity = workspace.reviews.map((review) => review.state?.updatedAt).filter(Boolean).sort().pop() || null;
  return {
    state,
    label: deliveryStateLabels[state],
    counts,
    hasRoadmap: Boolean(roadmap),
    updatedAt: roadmap?.updatedAt || activity,
    completedAt: completions.pop() || null,
    activityAt: activity,
    openRounds: workspace.reviews.filter((review) => review.state?.status !== "complete").length,
    proposals: workspace.reviews.reduce((total, review) => total + outstandingProposals(review.state).length, 0),
    percent: counts.outcomes ? Math.round((counts.integrated / counts.outcomes) * 100) : 0,
  };
}

const ATTENTION_WINDOW_HOURS = 24;

/**
 * The band is only worth reading if it empties. Everything here is work stopped
 * and waiting on a person; awaiting-authorization is a real backlog with no
 * deadline, so it stays behind a toggle rather than sitting here permanently.
 */
function attentionReasons(workspace, facts, now = Date.now()) {
  const reasons = [];
  if (facts.openRounds > 0) reasons.push({ kind: "open", tone: "amber", text: `${facts.openRounds} round${facts.openRounds === 1 ? "" : "s"} still open` });
  if (facts.state === "blocked") reasons.push({ kind: "blocked", tone: "red", text: "Roadmap blocked" });
  if (facts.proposals > 0) reasons.push({ kind: "proposal", tone: "amber", text: `${facts.proposals} proposal${facts.proposals === 1 ? "" : "s"} awaiting a person` });
  if (facts.state === "awaiting-authorization") reasons.push({ kind: "awaiting", tone: "amber", text: "Design closed, build never authorized" });
  if (facts.completedAt) {
    const hours = (now - new Date(facts.completedAt).getTime()) / 3600000;
    if (hours >= 0 && hours <= ATTENTION_WINDOW_HOURS) reasons.push({ kind: "done", tone: "green", text: `Completed ${relativeTime(facts.completedAt, now)}` });
  }
  return reasons;
}

function relativeTime(value, now = Date.now()) {
  const hours = (now - new Date(value).getTime()) / 3600000;
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function statusFacts(review) {
  const answers = Object.values(review.state?.answers || {});
  return {
    annotations: Array.isArray(review.state?.annotations) ? review.state.annotations.length : 0,
    complete: review.state?.status === "complete",
    decided: answers.filter((answer) => answer?.status === "decided").length,
    proposed: answers.filter((answer) => answer?.status === "proposed").length,
    updated: review.state?.updatedAt
      ? new Date(review.state.updatedAt).toLocaleString("en-GB")
      : "Not started",
  };
}

/** Machine-readable index for the staff app's own reviews page. */
function buildIndex(projects) {
  return {
    generatedAt: new Date().toISOString(),
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      summary: project.summary,
      workspaces: project.workspaces.map((workspace) => {
        const reviews = workspace.reviews.map((review) => {
          const facts = statusFacts(review);
          const questions = Array.isArray(review.questions) ? review.questions.length : 0;
          return {
            id: review.id,
            title: review.title,
            stage: review.stage || "Design review",
            kind: review.kind || "round",
            status: facts.complete ? "complete" : "in_progress",
            questions,
            decided: facts.decided,
            proposed: facts.proposed,
            openDecisions: Math.max(0, questions - facts.decided),
            annotations: facts.annotations,
            reviewer: review.state?.reviewer || null,
            updatedAt: review.state?.updatedAt || null,
            href: `projects/${project.id}/groups/${workspace.id}/reviews/${review.id}/`,
          };
        });
        const delivery = deliveryFacts(workspace);
        return {
          id: workspace.id,
          title: workspace.title,
          summary: workspace.summary,
          tags: workspace.tags || [],
          href: `projects/${project.id}/groups/${workspace.id}/`,
          deliveryState: delivery.state,
          roadmap: {
            href: `projects/${project.id}/groups/${workspace.id}/roadmap`,
            outcomes: delivery.counts.outcomes,
            integrated: delivery.counts.integrated,
            updatedAt: delivery.updatedAt,
          },
          rounds: reviews.length,
          complete: reviews.filter((review) => review.status === "complete").length,
          openDecisions: reviews.reduce((total, review) => total + review.openDecisions, 0),
          annotations: reviews.reduce((total, review) => total + review.annotations, 0),
          updatedAt: reviews.map((review) => review.updatedAt).filter(Boolean).sort().pop() || null,
          reviews,
        };
      }),
    })),
  };
}

function page(title, content, assetHref) {
  const liveHref = assetHref.replace(/library\.css$/, "live.js");
  const controlsHref = assetHref.replace(/library\.css$/, "library.js");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${assetHref}"><script src="${liveHref}" data-aw-live defer></script><script src="${controlsHref}" defer></script></head><body>${content}</body></html>`;
}

function workspaceHref(project, workspace) {
  return project.legacy
    ? `groups/${encodeURIComponent(workspace.id)}/`
    : `projects/${encodeURIComponent(project.id)}/groups/${encodeURIComponent(workspace.id)}/`;
}

function roadmapHref(project, workspace) {
  return project.legacy
    ? `groups/${encodeURIComponent(workspace.id)}/roadmap`
    : `projects/${encodeURIComponent(project.id)}/groups/${encodeURIComponent(workspace.id)}/roadmap`;
}

function statePill(facts) {
  return `<span class="pill state-${escapeHtml(facts.state)}">${escapeHtml(facts.label)}</span>`;
}

/**
 * Three bands: what is waiting, how delivery is going, then the directory.
 * Every band is rendered here with the default rule applied, so the page is
 * correct before library.js runs and complete without it.
 */
function renderHome(projects) {
  const now = Date.now();
  const rows = projects.flatMap((project) =>
    project.workspaces.map((workspace) => ({ project, workspace, facts: deliveryFacts(workspace) })));

  const attention = rows
    .map((row) => ({ ...row, reasons: attentionReasons(row.workspace, row.facts, now) }))
    .filter((row) => row.reasons.length)
    .sort((a, b) => (b.reasons.some((r) => r.kind !== "done") ? 1 : 0) - (a.reasons.some((r) => r.kind !== "done") ? 1 : 0));

  const attentionCards = attention.map(({ project, workspace, facts, reasons }) => {
    const waiting = reasons.some((reason) => reason.kind !== "done");
    const awaitingOnly = reasons.every((reason) => reason.kind === "awaiting");
    return `<a class="attention-row${waiting ? " waiting" : " done"}" href="${workspaceHref(project, workspace)}" data-attention data-kinds="${reasons.map((r) => r.kind).join(" ")}"${awaitingOnly ? ' data-awaiting-only="1"' : ""}>
      <span class="who"><b>${escapeHtml(workspace.title)}</b><span>${escapeHtml(project.title)} · ${escapeHtml(relativeTime(facts.activityAt || facts.updatedAt, now))}</span></span>
      <span class="marks">${reasons.map((reason) => `<span class="pill ${reason.tone}">${escapeHtml(reason.text)}</span>`).join("")}</span>
    </a>`;
  }).join("");

  const attentionBand = `<section class="band" data-band="attention">
    <div class="band-head"><div><span class="eyebrow">Band 1</span><h2>Needs attention</h2></div>
      <label class="toggle"><input type="checkbox" data-awaiting-toggle> Include awaiting authorization</label></div>
    <div class="attention-list">${attentionCards || '<p class="empty">Nothing is waiting on you.</p>'}</div>
    <p class="band-note" data-attention-note></p>
  </section>`;

  const roadmapRows = rows
    .filter((row) => row.facts.hasRoadmap)
    .sort((a, b) => String(b.facts.updatedAt || "").localeCompare(String(a.facts.updatedAt || "")))
    .map(({ project, workspace, facts }) => `<a class="roadmap-row" href="${roadmapHref(project, workspace)}" data-roadmap data-state="${escapeHtml(facts.state)}">
      <span class="who"><b>${escapeHtml(workspace.roadmap.title || workspace.title)}</b><span>${escapeHtml(project.title)} · ${facts.counts.integrated}/${facts.counts.outcomes} outcomes · ${escapeHtml(relativeTime(facts.updatedAt, now))}</span></span>
      <span class="marks">${statePill(facts)}<span class="percent">${facts.percent}%</span></span>
    </a>`).join("");

  const roadmapFilters = ["all", ...deliveryStates.filter((state) => rows.some((row) => row.facts.hasRoadmap && row.facts.state === state))];
  const roadmapBand = `<section class="band" data-band="roadmaps">
    <div class="band-head"><div><span class="eyebrow">Band 2</span><h2>Roadmaps</h2></div>
      <div class="seg" role="group" aria-label="Filter roadmaps by delivery state">${roadmapFilters.map((state) =>
        `<button type="button" data-roadmap-filter="${escapeHtml(state)}" aria-pressed="${state === "all"}">${state === "all" ? `All ${rows.filter((row) => row.facts.hasRoadmap).length}` : escapeHtml(deliveryStateLabels[state])}</button>`).join("")}</div></div>
    <div class="roadmap-list">${roadmapRows || '<p class="empty">No roadmaps yet.</p>'}</div>
  </section>`;

  const sections = projects.map((project) => {
    const ordered = [...project.workspaces].sort((a, b) => {
      const fa = deliveryFacts(a);
      const fb = deliveryFacts(b);
      if ((fb.openRounds > 0) !== (fa.openRounds > 0)) return (fb.openRounds > 0) - (fa.openRounds > 0);
      const byActivity = String(fb.activityAt || "").localeCompare(String(fa.activityAt || ""));
      if (byActivity) return byActivity;
      return Number(a.order || 0) - Number(b.order || 0);
    });

    if (!ordered.length) {
      return `<section class="project-section empty-project"><div class="project-head compact"><div><span class="eyebrow">Project</span><h2>${escapeHtml(project.title)}</h2></div><span class="count">no workspaces yet · /${escapeHtml(project.id)}</span></div></section>`;
    }

    const cards = ordered.map((workspace) => {
      const facts = deliveryFacts(workspace);
      const tags = (workspace.tags || []).slice(0, 3);
      return `<article class="workspace-card${facts.openRounds ? " open" : ""}">
        <div class="card-top"><span class="eyebrow">${escapeHtml(project.title)}</span><span class="count">${workspace.reviews.length} round${workspace.reviews.length === 1 ? "" : "s"} · ${escapeHtml(relativeTime(facts.activityAt || facts.updatedAt, now))}</span></div>
        <h2>${escapeHtml(workspace.title)}</h2><p>${escapeHtml(workspace.summary)}</p>
        <div class="marks">${statePill(facts)}${facts.openRounds ? `<span class="pill amber">${facts.openRounds} open</span>` : ""}${facts.counts.outcomes ? `<span class="pill">${facts.counts.integrated} of ${facts.counts.outcomes} integrated</span>` : ""}</div>
        ${tags.length ? `<div class="tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
        <div class="card-actions"><a class="button" href="${workspaceHref(project, workspace)}">Open workspace →</a>${facts.hasRoadmap ? `<a class="button ghost" href="${roadmapHref(project, workspace)}">Roadmap</a>` : ""}</div>
      </article>`;
    }).join("");

    return `<section class="project-section"><div class="project-head"><div><span class="eyebrow">Project</span><h2>${escapeHtml(project.title)}</h2><p>${escapeHtml(project.summary)}</p></div><span class="count"><a href="${project.legacy ? "" : `projects/${encodeURIComponent(project.id)}/roadmap`}">/${escapeHtml(project.id)}</a></span></div><section class="grid">${cards}</section></section>`;
  }).join("");

  const body = `<main class="wrap"><header><span class="eyebrow">One server · project workspaces</span><h1>Assistant Workspace</h1><p>Every project below contains durable pieces of work that any authorized agent can continue.</p></header><aside class="notice"><b>Build gate:</b> completing a review records design decisions. It never authorizes implementation.</aside>${attentionBand}${roadmapBand}<section class="band" data-band="projects"><div class="band-head"><div><span class="eyebrow">Band 3</span><h2>Projects and workspaces</h2></div></div>${sections || '<section class="grid"><div class="empty">No projects found. Create one with npm run project:create.</div></section>'}</section></main>`;
  return page("Assistant Workspace", body, "assets/library.css");
}

/** Derived from the workspace roadmaps. Nothing is authored at project level. */
function renderProjectRoadmap(project) {
  const now = Date.now();
  const rows = project.workspaces.map((workspace) => ({ workspace, facts: deliveryFacts(workspace) }));
  const totals = deliveryStates.map((state) => ({ state, count: rows.filter((row) => row.facts.state === state).length })).filter((entry) => entry.count);
  const outcomes = rows.reduce((total, row) => total + row.facts.counts.outcomes, 0);
  const integrated = rows.reduce((total, row) => total + row.facts.counts.integrated, 0);

  const cards = rows
    .sort((a, b) => String(b.facts.updatedAt || "").localeCompare(String(a.facts.updatedAt || "")))
    .map(({ workspace, facts }) => `<article class="workspace-card">
      <div class="card-top"><span class="eyebrow">${workspace.reviews.length} round${workspace.reviews.length === 1 ? "" : "s"}</span><span class="count">${escapeHtml(relativeTime(facts.updatedAt, now))}</span></div>
      <h2>${escapeHtml(workspace.title)}</h2><p>${escapeHtml(workspace.summary)}</p>
      <div class="marks">${statePill(facts)}${facts.counts.outcomes ? `<span class="pill">${facts.counts.integrated} of ${facts.counts.outcomes} integrated</span>` : ""}${facts.hasRoadmap ? "" : '<span class="pill">no roadmap yet</span>'}</div>
      <div class="card-actions"><a class="button" href="groups/${encodeURIComponent(workspace.id)}/">Open workspace →</a>${facts.hasRoadmap ? `<a class="button ghost" href="groups/${encodeURIComponent(workspace.id)}/roadmap">Roadmap</a>` : ""}</div>
    </article>`).join("");

  const body = `<main class="wrap"><nav><a href="../../">← All projects</a></nav><header><span class="eyebrow">${escapeHtml(project.title)} · Programme</span><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(project.summary)}</p></header>
    <aside class="notice"><b>Derived view.</b> Every figure here is read from the workspace roadmaps on request. There is no project-level file to keep in step.</aside>
    <section class="facts-row">${totals.map((entry) => `<div class="fact"><span>${escapeHtml(deliveryStateLabels[entry.state])}</span><b>${entry.count}</b></div>`).join("")}<div class="fact"><span>Outcomes integrated</span><b>${integrated} of ${outcomes}</b></div></section>
    <section class="grid">${cards || '<div class="empty">This project has no workspaces yet.</div>'}</section></main>`;
  return page(`${project.title} — programme`, body, "../assets/library.css");
}

function renderWorkspace(project, workspace) {
  const cards = workspace.reviews.map((review) => {
    const facts = statusFacts(review);
    return `<article class="review-card">
      <div class="card-top"><span class="stage">${escapeHtml(review.stage || "Design review")}</span><span class="status ${facts.complete ? "complete" : "progress"}">${facts.complete ? "Complete" : "In progress"}</span></div>
      <h2>${escapeHtml(review.title)}</h2><p>${escapeHtml(review.summary)}</p>
      <div class="facts"><span><b>${facts.decided}</b> decisions</span><span><b>${facts.annotations}</b> annotations</span><span>${escapeHtml(facts.updated)}</span></div>
      <a class="button" href="reviews/${encodeURIComponent(review.id)}/">Open round →</a>
    </article>`;
  }).join("");
  const assetHref = project.legacy ? "../../assets/library.css" : "../../../../assets/library.css";
  const homeHref = project.legacy ? "../../" : "../../../../";
  const facts = deliveryFacts(workspace);
  const roadmapLink = facts.hasRoadmap
    ? `<a class="button ghost" href="roadmap">Roadmap · ${escapeHtml(facts.label)}${facts.counts.outcomes ? ` · ${facts.counts.integrated}/${facts.counts.outcomes}` : ""}</a>`
    : "";
  return page(workspace.title, `<main class="wrap"><nav><a href="${homeHref}">← All projects</a></nav><header><span class="eyebrow">${escapeHtml(project.title)} · Workspace</span><h1>${escapeHtml(workspace.title)}</h1><p>${escapeHtml(workspace.summary)}</p><div class="marks">${statePill(facts)}${roadmapLink}</div></header><section class="grid">${cards || '<div class="empty">This workspace has no rounds yet.</div>'}</section></main>`, assetHref);
}

// Injected into every mock document. The mock frame is sandboxed, so it runs on an
// opaque origin: the shell can no longer reach into its DOM, and messages it sends
// arrive with `event.origin === "null"`. This bridge carries annotation both ways.
// Prototypes that post with `location.origin` keep working unchanged — inside a
// sandboxed frame that still resolves to the real URL origin; it is `window.origin`
// that becomes "null".
const bridgeScript = `<script data-assistant-workspace-bridge>
(function () {
  if (window.__assistantWorkspaceBridge) return;
  window.__assistantWorkspaceBridge = true;
  var shellOrigin = "*";
  var annotating = false;
  var realParent = window.parent;
  function post(message) {
    try { realParent.postMessage(message, shellOrigin); }
    catch (error) { try { realParent.postMessage(message, "*"); } catch (ignored) {} }
  }
  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type === "assistant-workspace:hello") {
      if (typeof data.origin === "string" && data.origin !== "null") shellOrigin = data.origin;
      return;
    }
    if (data.type === "assistant-workspace:annotation-mode") {
      annotating = !!data.on;
      document.documentElement.classList.toggle("review-annotation-mode", annotating);
    }
  });
  document.addEventListener("click", function (event) {
    if (!annotating) return;
    event.preventDefault();
    event.stopPropagation();
    var node = event.target;
    var target = node && node.closest ? node.closest("[data-review-target]") : null;
    if (!target) { post({ type: "assistant-workspace:annotate-miss" }); return; }
    post({
      type: "assistant-workspace:annotate-target",
      key: target.getAttribute("data-review-target"),
      label: target.getAttribute("data-review-label") || target.getAttribute("aria-label") || (target.textContent || "").trim().slice(0, 80) || target.getAttribute("data-review-target")
    });
  }, true);
  post({ type: "assistant-workspace:ready" });
})();
<\/script>`;

// A sandboxed document is a cross-site context: its own subresource requests
// carry no cookies, so behind an authenticating proxy every <link> and <script src>
// in a mock is refused while the document itself loads fine — the prototype
// renders unstyled and inert, with nothing in the console to explain it.
// Same-directory stylesheets and scripts are therefore inlined as the document is
// served, which keeps the sandbox, keeps the gate, and needs no change to
// authored prototypes.
function isBesideTheMock(url) {
  // Only files beside the mock: anything absolute or remote is left as authored.
  return Boolean(url) && !/^(https?:)?\/\//i.test(url) && !url.startsWith("/") && !url.includes("..");
}

async function inlineMockAssets(html, directory) {
  let result = html;

  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!isBesideTheMock(href)) continue;
    const target = safeStaticPath(directory, href.split("?")[0]);
    if (!target) continue;
    try {
      const css = await readFile(target, "utf8");
      result = result.replace(tag, `<style data-inlined-from="${escapeHtml(href)}">\n${css}\n</style>`);
    } catch { /* missing file: leave the link as authored */ }
  }

  for (const [tag] of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi)) {
    // `defer` and `async` change when a script runs, and an inline script cannot
    // express either. Leave those alone rather than silently altering ordering.
    if (/\b(defer|async)\b/i.test(tag)) continue;
    const src = tag.match(/src\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!isBesideTheMock(src)) continue;
    const target = safeStaticPath(directory, src.split("?")[0]);
    if (!target) continue;
    try {
      const code = await readFile(target, "utf8");
      // A closing tag inside a string literal would end the block early.
      result = result.replace(tag, `<script data-inlined-from="${escapeHtml(src)}">\n${code.replaceAll("</script", "<\\/script")}\n</script>`);
    } catch { /* missing file: leave the tag as authored */ }
  }

  return result;
}

function injectBridge(html) {
  if (html.includes("data-assistant-workspace-bridge")) return html;
  const head = html.match(/<\/head\s*>/i);
  if (head) return html.replace(head[0], `${bridgeScript}${head[0]}`);
  const body = html.match(/<body[^>]*>/i);
  if (body) return html.replace(body[0], `${body[0]}${bridgeScript}`);
  return `${bridgeScript}${html}`;
}

function safeStaticPath(root, requested) {
  const candidate = resolve(root, normalize(decodeURIComponent(requested).replace(/^\/+/, "")));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

async function serveStatic(response, root, requested, { injectBridgeScript = false } = {}) {
  const target = safeStaticPath(root, requested);
  if (!target) return send(response, 403, "Forbidden");
  try {
    const info = await stat(target);
    if (!info.isFile()) return send(response, 404, "Not found");
    if (injectBridgeScript && extname(target) === ".html") {
      const html = await inlineMockAssets(await readFile(target, "utf8"), root);
      return send(response, 200, injectBridge(html), mime[".html"]);
    }
    return send(response, 200, await readFile(target), mime[extname(target)] || "application/octet-stream");
  } catch (error) {
    if (error?.code === "ENOENT") return send(response, 404, "Not found");
    throw error;
  }
}

function findProject(projects, id) {
  return idPattern.test(id) ? projects.find((item) => item.id === id) : null;
}

function findWorkspace(project, id) {
  return idPattern.test(id) ? project?.workspaces.find((item) => item.id === id) : null;
}

function findUniqueWorkspace(projects, id) {
  if (!idPattern.test(id)) return null;
  const matches = projects.flatMap((project) => project.workspaces.filter((workspace) => workspace.id === id).map((workspace) => ({ project, workspace })));
  return matches.length === 1 ? matches[0] : null;
}

function findReview(workspace, id) {
  return idPattern.test(id) ? workspace?.reviews.find((item) => item.id === id) : null;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);

    // Live updates. One stream per open page; a heartbeat keeps proxies from closing it.
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 5000\n\n");
      eventClients.add(response);
      const heartbeat = setInterval(() => {
        try { response.write(": ping\n\n"); } catch { clearInterval(heartbeat); eventClients.delete(response); }
      }, 25000);
      request.on("close", () => { clearInterval(heartbeat); eventClients.delete(response); });
      return;
    }

    // The publisher announces a content change. Localhost + shared secret only, and
    // 404 rather than 403 so an unauthenticated caller learns nothing about it.
    if (request.method === "POST" && url.pathname === "/internal/invalidate") {
      const remote = request.socket.remoteAddress || "";
      const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
      const secretOk = Boolean(invalidateSecret) && request.headers["x-review-invalidate-secret"] === invalidateSecret;
      if (!isLocal || !secretOk) return send(response, 404, "Not found");
      invalidateIndex("publish");
      return send(response, 200, JSON.stringify({ ok: true }), mime[".json"]);
    }

    const projects = await getProjects();

    if (request.method === "GET" && url.pathname === "/api/index.json") {
      return send(response, 200, `${JSON.stringify(buildIndex(projects), null, 2)}\n`, mime[".json"]);
    }

    if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
      return send(response, 200, renderHome(projects), mime[".html"]);
    }
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      return serveStatic(response, join(appRoot, "engine"), url.pathname.slice("/assets/".length));
    }
    const projectAssetMatch = url.pathname.match(/^\/projects\/[^/]+\/assets\/(.+)$/);
    if (request.method === "GET" && projectAssetMatch) {
      return serveStatic(response, join(appRoot, "engine"), projectAssetMatch[1]);
    }

    const projectRoadmapMatch = url.pathname.match(/^\/projects\/([^/]+)\/roadmap\/?$/);
    if (request.method === "GET" && projectRoadmapMatch) {
      const project = findProject(projects, decodeURIComponent(projectRoadmapMatch[1]));
      return project
        ? send(response, 200, renderProjectRoadmap(project), mime[".html"])
        : send(response, 404, "Project not found");
    }

    const workspaceRoadmapMatch = url.pathname.match(/^\/projects\/([^/]+)\/groups\/([^/]+)\/roadmap\/?$/);
    const legacyRoadmapMatch = url.pathname.match(/^\/groups\/([^/]+)\/roadmap\/?$/);
    if (request.method === "GET" && (workspaceRoadmapMatch || legacyRoadmapMatch)) {
      let workspace;
      if (workspaceRoadmapMatch) {
        const project = findProject(projects, decodeURIComponent(workspaceRoadmapMatch[1]));
        workspace = findWorkspace(project, decodeURIComponent(workspaceRoadmapMatch[2]));
      } else {
        workspace = findUniqueWorkspace(projects, decodeURIComponent(legacyRoadmapMatch[1]))?.workspace;
      }
      if (!workspace) return send(response, 404, "Workspace not found");
      if (!workspace.roadmap) return send(response, 404, "This workspace has no roadmap yet");
      try {
        return send(response, 200, renderRoadmap(workspace.roadmap), mime[".html"]);
      } catch (error) {
        return send(response, 500, `Roadmap could not be rendered.\n\n${error.message}`);
      }
    }

    // The roadmap moved out of the Final Review it was authored in. Those URLs are
    // in commit messages and handoffs, so they redirect rather than 404 — there is
    // no future date on which breaking them is worth anything.
    const legacyArtifactMatch = url.pathname.match(/^\/projects\/([^/]+)\/groups\/([^/]+)\/reviews\/[^/]+\/artifacts\/([^/]+)$/);
    if (request.method === "GET" && legacyArtifactMatch && roadmapRedirects.has(url.pathname)) {
      // Only once the workspace actually holds the roadmap. Engine and content
      // deploy independently, so redirecting before the file has landed would
      // turn a working artifact URL into a 404 for the length of the gap.
      const redirectProject = findProject(projects, decodeURIComponent(legacyArtifactMatch[1]));
      const redirectWorkspace = findWorkspace(redirectProject, decodeURIComponent(legacyArtifactMatch[2]));
      if (redirectWorkspace?.roadmap) {
        response.writeHead(301, { Location: roadmapRedirects.get(url.pathname) });
        return response.end();
      }
    }

    const projectWorkspaceMatch = url.pathname.match(/^\/projects\/([^/]+)\/groups\/([^/]+)\/?$/);
    if (request.method === "GET" && projectWorkspaceMatch) {
      const project = findProject(projects, decodeURIComponent(projectWorkspaceMatch[1]));
      const workspace = findWorkspace(project, decodeURIComponent(projectWorkspaceMatch[2]));
      return workspace
        ? send(response, 200, renderWorkspace(project, workspace), mime[".html"])
        : send(response, 404, "Workspace not found");
    }

    const legacyWorkspaceMatch = url.pathname.match(/^\/groups\/([^/]+)\/?$/);
    if (request.method === "GET" && legacyWorkspaceMatch) {
      const match = findUniqueWorkspace(projects, decodeURIComponent(legacyWorkspaceMatch[1]));
      return match
        ? send(response, 200, renderWorkspace(match.project, match.workspace), mime[".html"])
        : send(response, 404, "Workspace not found or not unique");
    }

    let project;
    let workspace;
    let reviewId;
    let suffix;
    const projectReviewMatch = url.pathname.match(/^\/projects\/([^/]+)\/groups\/([^/]+)\/reviews\/([^/]+)(\/.*)?$/);
    const legacyReviewMatch = url.pathname.match(/^\/groups\/([^/]+)\/reviews\/([^/]+)(\/.*)?$/);
    if (projectReviewMatch) {
      project = findProject(projects, decodeURIComponent(projectReviewMatch[1]));
      workspace = findWorkspace(project, decodeURIComponent(projectReviewMatch[2]));
      reviewId = decodeURIComponent(projectReviewMatch[3]);
      suffix = projectReviewMatch[4] || "/";
    } else if (legacyReviewMatch) {
      const match = findUniqueWorkspace(projects, decodeURIComponent(legacyReviewMatch[1]));
      project = match?.project;
      workspace = match?.workspace;
      reviewId = decodeURIComponent(legacyReviewMatch[2]);
      suffix = legacyReviewMatch[3] || "/";
    } else {
      return send(response, 404, "Not found");
    }
    const review = findReview(workspace, reviewId);
    if (!project || !workspace || !review) return send(response, 404, "Review not found");
    const stateDirectory = review.stateDirectory;

    if (request.method === "GET" && suffix === "/") {
      return serveStatic(response, join(appRoot, "engine"), "review.html");
    }
    if (request.method === "GET" && suffix === "/review.json") {
      return send(response, 200, `${JSON.stringify({ ...review, directory: undefined, stateDirectory: undefined, state: undefined, project: { id: project.id, title: project.title }, workspace: { id: workspace.id, title: workspace.title } }, null, 2)}\n`, mime[".json"]);
    }
    if (request.method === "GET" && suffix === "/api/state") {
      const state = await optionalJson(join(stateDirectory, "state.json"));
      return state ? send(response, 200, `${JSON.stringify(state)}\n`, mime[".json"]) : send(response, 204);
    }
    if (request.method === "POST" && suffix === "/api/review") {
      const payload = await readJsonBody(request);
      if (!payload || typeof payload.markdown !== "string" || !payload.state || typeof payload.state !== "object") {
        return send(response, 400, JSON.stringify({ error: "invalid_payload" }), mime[".json"]);
      }
      const identity = identityFrom(request);
      const current = await optionalJson(join(stateDirectory, "state.json"));

      // Capability, in three separate questions rather than one:
      //   annotate — may change annotations
      //   decide   — may change answers
      //   complete — may change the round's status
      if (identity) {
        const decidesChanged = decisionFingerprint(current) !== decisionFingerprint(payload.state);
        const statusChanged = completionFingerprint(current) !== completionFingerprint(payload.state);

        if (!identity.capabilities.includes("annotate")) {
          return send(response, 403, JSON.stringify({ error: "read_only" }), mime[".json"]);
        }
        if (decidesChanged && !identity.capabilities.includes("decide")) {
          return send(response, 403, JSON.stringify({ error: "decide_not_permitted" }), mime[".json"]);
        }
        if (statusChanged && !identity.capabilities.includes("complete")) {
          return send(response, 403, JSON.stringify({
            error: identity.kind === "agent" ? "completion_is_human_only" : "complete_not_permitted",
          }), mime[".json"]);
        }
      }

      // A round cannot claim decisions nobody agreed to. Refuse with the count,
      // because "three proposals still awaiting you" is actionable and
      // "cannot complete" is not.
      if (payload.state.status === "complete" && current?.status !== "complete") {
        const proposals = outstandingProposals(payload.state);
        if (proposals.length) {
          return send(response, 409, JSON.stringify({ error: "proposals_outstanding", questions: proposals }), mime[".json"]);
        }
      }

      // Optimistic concurrency: a write from a stale page is refused, not merged away.
      const currentVersion = Number(current?.version || 0);
      const baseVersion = Number(payload.baseVersion ?? payload.state.version ?? 0);
      if (current && baseVersion !== currentVersion) {
        return send(response, 409, JSON.stringify({ error: "version_conflict", state: current }), mime[".json"]);
      }

      const next = { ...payload.state, version: currentVersion + 1 };
      if (identity) {
        // The reviewer name is a human's. An agent writing proposals must not
        // rename the review after the person who owns it.
        if (identity.kind !== "agent") {
          next.reviewer = identity.display;
        }
        next.updatedBy = identity.user;
        next.answers = stampAnswerAuthorship(current?.answers, next.answers, identity);
        next.annotations = (Array.isArray(next.annotations) ? next.annotations : []).map((note) =>
          note && !note.author ? { ...note, author: identity.display, authorId: identity.user } : note);
      }
      await Promise.all([
        writeAtomic(join(stateDirectory, "feedback.md"), payload.markdown),
        writeAtomic(join(stateDirectory, "state.json"), `${JSON.stringify(next, null, 2)}\n`),
      ]);
      invalidateIndex("state", "state-changed");
      return send(response, 200, JSON.stringify({ ok: true, version: next.version }), mime[".json"]);
    }
    // A narrow write for agents: one answer, no compiled handoff, no
    // read-modify-write of the whole document. The full endpoint above exists for
    // the browser, which owns the Markdown handoff; an agent has no business
    // rewriting a human-facing artifact to record one proposal.
    if (request.method === "POST" && suffix === "/api/propose") {
      const payload = await readJsonBody(request);
      const questionId = payload?.questionId;
      if (!payload || typeof questionId !== "string" || typeof payload.selected !== "string") {
        return send(response, 400, JSON.stringify({ error: "invalid_payload" }), mime[".json"]);
      }
      const identity = identityFrom(request);
      if (!identity) return send(response, 403, JSON.stringify({ error: "identity_required" }), mime[".json"]);
      if (!identity.capabilities.includes("decide")) {
        return send(response, 403, JSON.stringify({ error: "decide_not_permitted" }), mime[".json"]);
      }

      const question = (review.questions || []).find((item) => item.id === questionId);
      if (!question) return send(response, 404, JSON.stringify({ error: "unknown_question" }), mime[".json"]);
      if (!(question.options || []).some((option) => option.id === payload.selected) && payload.selected !== "own-view") {
        return send(response, 422, JSON.stringify({ error: "unknown_option", options: (question.options || []).map((option) => option.id) }), mime[".json"]);
      }

      const current = await optionalJson(join(stateDirectory, "state.json"));
      const currentVersion = Number(current?.version || 0);
      if (current && Number(payload.baseVersion ?? currentVersion) !== currentVersion) {
        return send(response, 409, JSON.stringify({ error: "version_conflict", version: currentVersion }), mime[".json"]);
      }

      const base = current || { schema: 1, version: 0, status: "in_progress", startedAt: new Date().toISOString(), answers: {}, annotations: [], customQuestions: [], overallNotes: "", reviewer: "" };
      const answers = { ...(base.answers || {}) };
      answers[questionId] = {
        ...(answers[questionId] || {}),
        selected: payload.selected,
        notes: typeof payload.notes === "string" ? payload.notes : answers[questionId]?.notes || "",
        ...(typeof payload.reasoning === "string" ? { reasoning: payload.reasoning } : {}),
        status: "decided",
      };
      const next = {
        ...base,
        answers: stampAnswerAuthorship(base.answers, answers, identity),
        version: currentVersion + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: identity.user,
      };
      await writeAtomic(join(stateDirectory, "state.json"), `${JSON.stringify(next, null, 2)}\n`);
      invalidateIndex("state", "state-changed");
      return send(response, 200, JSON.stringify({
        ok: true,
        version: next.version,
        status: next.answers[questionId].status,
      }), mime[".json"]);
    }

    if (request.method !== "GET") return send(response, 405, "Method not allowed");
    const mockMatch = suffix.match(/^\/mocks\/([^/]+)\/(.+)$/);
    if (mockMatch) {
      const mock = review.mocks?.find((item) => item.id === decodeURIComponent(mockMatch[1]));
      const sourceReview = mock?.sourceReview ? findReview(workspace, mock.sourceReview) : review;
      if (!mock || !sourceReview) return send(response, 404, "Mock not found");
      return serveStatic(response, join(sourceReview.directory, "mocks"), mockMatch[2], { injectBridgeScript: true });
    }
    const artifactMatch = suffix.match(/^\/artifacts\/([^/]+)$/);
    if (artifactMatch) {
      const artifact = review.artifacts?.find((item) => item.id === decodeURIComponent(artifactMatch[1]));
      if (!artifact?.file) return send(response, 404, "Artifact not found");
      if (artifact.format === "roadmap") {
        const roadmap = await readJson(join(review.directory, "artifacts", artifact.file));
        return send(response, 200, renderRoadmap(roadmap), mime[".html"]);
      }
      return serveStatic(response, join(review.directory, "artifacts"), artifact.file);
    }
    return send(response, 404, "Not found");
  } catch (error) {
    const status = error?.message === "body_too_large" ? 413 : error?.message === "invalid_json" ? 400 : 500;
    send(response, status, JSON.stringify({ error: error?.message || "server_error" }), mime[".json"]);
  }
});

server.listen(port, host, () => {
  const source = projectsRoot ? `Projects: ${projectsRoot}` : `Content: ${contentRoot}\nState: ${dataRoot}`;
  process.stdout.write(`Assistant Workspace: http://${host}:${port}\n${source}\n`);
});
