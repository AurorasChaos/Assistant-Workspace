import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderRoadmap } from "./lib/roadmap.mjs";

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
  return {
    user,
    display: typeof request.headers["x-review-display"] === "string" ? request.headers["x-review-display"] : user,
    capabilities,
  };
}

/** Everything a reviewer needs `decide` for. Annotations and custom questions are excluded. */
function decisionFingerprint(state) {
  return JSON.stringify({
    answers: state?.answers || {},
    status: state?.status || "in_progress",
    overallNotes: state?.overallNotes || "",
    customQuestions: state?.customQuestions || [],
  });
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
    workspaces.push({ ...manifest, directory, reviews, projectId: project.id });
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

function statusFacts(review) {
  const answers = Object.values(review.state?.answers || {});
  return {
    annotations: Array.isArray(review.state?.annotations) ? review.state.annotations.length : 0,
    complete: review.state?.status === "complete",
    decided: answers.filter((answer) => answer?.status === "decided").length,
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
            openDecisions: Math.max(0, questions - facts.decided),
            annotations: facts.annotations,
            reviewer: review.state?.reviewer || null,
            updatedAt: review.state?.updatedAt || null,
            href: `projects/${project.id}/groups/${workspace.id}/reviews/${review.id}/`,
          };
        });
        return {
          id: workspace.id,
          title: workspace.title,
          summary: workspace.summary,
          tags: workspace.tags || [],
          href: `projects/${project.id}/groups/${workspace.id}/`,
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${assetHref}"><script src="${liveHref}" data-aw-live defer></script></head><body>${content}</body></html>`;
}

function workspaceHref(project, workspace) {
  return project.legacy
    ? `groups/${encodeURIComponent(workspace.id)}/`
    : `projects/${encodeURIComponent(project.id)}/groups/${encodeURIComponent(workspace.id)}/`;
}

function renderHome(projects) {
  const sections = projects.map((project) => {
    const cards = project.workspaces.map((workspace) => {
      const completed = workspace.reviews.filter((review) => statusFacts(review).complete).length;
      return `<article class="workspace-card">
        <div class="card-top"><span class="eyebrow">${escapeHtml(project.title)}</span><span class="count">${workspace.reviews.length} round${workspace.reviews.length === 1 ? "" : "s"}</span></div>
        <h2>${escapeHtml(workspace.title)}</h2><p>${escapeHtml(workspace.summary)}</p>
        <div class="facts"><span><b>${completed}</b> complete</span><span><b>${workspace.reviews.length - completed}</b> open</span></div>
        <a class="button" href="${workspaceHref(project, workspace)}">Open workspace →</a>
      </article>`;
    }).join("");
    return `<section class="project-section"><div class="project-head"><div><span class="eyebrow">Project</span><h2>${escapeHtml(project.title)}</h2><p>${escapeHtml(project.summary)}</p></div><span class="count">/${escapeHtml(project.id)}</span></div><section class="grid">${cards || '<div class="empty">This project has no workspaces yet.</div>'}</section></section>`;
  }).join("");
  return page("Assistant Workspace", `<main class="wrap"><header><span class="eyebrow">One server · project workspaces</span><h1>Assistant Workspace</h1><p>Atlas, Beacon, Harbour and future projects each contain durable pieces of work that any authorized agent can continue.</p></header><aside class="notice"><b>Build gate:</b> completing a review records design decisions. It never authorizes implementation.</aside>${sections || '<section class="grid"><div class="empty">No projects found. Create one with npm run project:create.</div></section>'}</main>`, "assets/library.css");
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
  return page(workspace.title, `<main class="wrap"><nav><a href="${homeHref}">← All projects</a></nav><header><span class="eyebrow">${escapeHtml(project.title)} · Workspace</span><h1>${escapeHtml(workspace.title)}</h1><p>${escapeHtml(workspace.summary)}</p></header><section class="grid">${cards || '<div class="empty">This workspace has no rounds yet.</div>'}</section></main>`, assetHref);
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
      return send(response, 200, injectBridge(await readFile(target, "utf8")), mime[".html"]);
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

      // Capability: `decide` records answers and completion, `annotate` only annotates.
      if (identity && !identity.capabilities.includes("decide")) {
        if (!identity.capabilities.includes("annotate")) {
          return send(response, 403, JSON.stringify({ error: "read_only" }), mime[".json"]);
        }
        if (decisionFingerprint(current) !== decisionFingerprint(payload.state)) {
          return send(response, 403, JSON.stringify({ error: "decide_not_permitted" }), mime[".json"]);
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
        next.reviewer = identity.display;
        next.updatedBy = identity.user;
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
