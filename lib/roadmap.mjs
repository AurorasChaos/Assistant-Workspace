const roadmapStatuses = new Set(["queued", "active", "blocked", "complete"]);

/** Delivery state is authored, not derived: the build gate is a human fact. */
export const deliveryStates = ["designing", "awaiting-authorization", "building", "shipped", "blocked"];
const deliveryStateSet = new Set(deliveryStates);
export const deliveryStateLabels = {
  designing: "Designing",
  "awaiting-authorization": "Awaiting authorization",
  building: "Building",
  shipped: "Shipped",
  blocked: "Blocked",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusOf(value) {
  return roadmapStatuses.has(value) ? value : "queued";
}

function statusLabel(value) {
  return { queued: "Queued", active: "Active", blocked: "Blocked", complete: "Complete" }[statusOf(value)];
}

function validateText(errors, value, path) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} is required`);
}

const laneList = (data) => (Array.isArray(data?.lanes) ? data.lanes : []);
const phaseList = (data) => (Array.isArray(data?.phases) ? data.phases : []);
const itemList = (data) => laneList(data).flatMap((lane) => (Array.isArray(lane?.items) ? lane.items : []));

/**
 * A version-1 roadmap predates phases carrying their authorizing Final Review.
 * It reads as one unnamed phase owning every lane, so the nine files written
 * before this schema keep rendering unchanged.
 */
export function deliveryStateOf(data) {
  if (deliveryStateSet.has(data?.deliveryState)) return data.deliveryState;
  const items = itemList(data);
  if (!items.length) return "designing";
  if (items.every((item) => item?.status === "complete")) return "shipped";
  if (items.some((item) => item?.commit)) return "building";
  return "awaiting-authorization";
}

/**
 * How many programmes one file carries. A roadmap authored against a single Final
 * Review has one, however many pipeline phases it draws; a file that absorbed a
 * replacement Final Review has two. Attribution is only required above one —
 * `phases.length` counts display cards and is the wrong question.
 */
export function programmesOf(data) {
  return [...new Set(phaseList(data).map((phase) => phase?.sourceFinalReview).filter(Boolean))];
}

export function roadmapCounts(data) {
  const items = itemList(data);
  return {
    lanes: laneList(data).length,
    phases: phaseList(data).length,
    outcomes: items.length,
    integrated: items.filter((item) => item?.status === "complete").length,
    commits: items.filter((item) => item?.commit).length,
  };
}

export function validateRoadmap(data, source = "roadmap") {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return [`${source} must be an object`];
  if (![1, 2].includes(data.schemaVersion)) errors.push(`${source}.schemaVersion must be 1 or 2`);
  validateText(errors, data.title, `${source}.title`);
  validateText(errors, data.summary, `${source}.summary`);

  const version = data.schemaVersion === 2 ? 2 : 1;
  if (version === 2) {
    if (!deliveryStateSet.has(data.deliveryState)) {
      errors.push(`${source}.deliveryState must be one of ${deliveryStates.join(", ")}`);
    }
    // A workspace created a minute ago has no rounds to name, so this follows the
    // state like emptiness does: required as soon as there is a programme.
    if (data.sourceReviews !== undefined && (!Array.isArray(data.sourceReviews) || data.sourceReviews.some((id) => typeof id !== "string" || !id.trim()))) {
      errors.push(`${source}.sourceReviews must be an array of review ids`);
    } else if (data.deliveryState !== "designing" && !(data.sourceReviews || []).length) {
      errors.push(`${source}.sourceReviews must name the reviews this roadmap implements`);
    }
  } else if (data.deliveryState !== undefined && !deliveryStateSet.has(data.deliveryState)) {
    errors.push(`${source}.deliveryState must be one of ${deliveryStates.join(", ")}`);
  }

  const phases = phaseList(data);
  const lanes = laneList(data);
  const state = deliveryStateOf(data);
  const multiProgramme = version === 2 && programmesOf(data).length > 1;

  // Emptiness follows the state. A workspace that has not been designed has no
  // programme to describe; one that claims to be shipped has to show something.
  if (state !== "designing") {
    if (!lanes.length) errors.push(`${source}.lanes must contain at least one lane unless deliveryState is designing`);
    if (state === "shipped" && lanes.length && !itemList(data).some((item) => item?.status === "complete")) {
      errors.push(`${source} is shipped but no outcome is complete`);
    }
  }

  const ids = new Set();
  const phaseIds = new Set();
  for (const [index, phase] of phases.entries()) {
    const path = `${source}.phases[${index}]`;
    validateText(errors, phase?.id, `${path}.id`);
    validateText(errors, phase?.title, `${path}.title`);
    if (ids.has(phase?.id)) errors.push(`${path}.id must be unique`);
    ids.add(phase?.id);
    phaseIds.add(phase?.id);
    if (!roadmapStatuses.has(phase?.status)) errors.push(`${path}.status must be queued, active, blocked or complete`);
    if (multiProgramme) validateText(errors, phase?.sourceFinalReview, `${path}.sourceFinalReview`);
  }
  for (const [laneIndex, lane] of lanes.entries()) {
    const path = `${source}.lanes[${laneIndex}]`;
    validateText(errors, lane?.id, `${path}.id`);
    validateText(errors, lane?.title, `${path}.title`);
    if (ids.has(lane?.id)) errors.push(`${path}.id must be unique across phases and lanes`);
    ids.add(lane?.id);
    if (!roadmapStatuses.has(lane?.status)) errors.push(`${path}.status must be queued, active, blocked or complete`);
    if (multiProgramme) {
      if (typeof lane?.phase !== "string" || !lane.phase.trim()) errors.push(`${path}.phase is required when the roadmap carries more than one programme`);
      else if (!phaseIds.has(lane.phase)) errors.push(`${path}.phase must name a phase id`);
    }
    if (!Array.isArray(lane?.items) || !lane.items.length) errors.push(`${path}.items must contain at least one outcome`);
    for (const [itemIndex, item] of (lane?.items || []).entries()) {
      const itemPath = `${path}.items[${itemIndex}]`;
      validateText(errors, item?.id, `${itemPath}.id`);
      validateText(errors, item?.title, `${itemPath}.title`);
      if (!roadmapStatuses.has(item?.status)) errors.push(`${itemPath}.status must be queued, active, blocked or complete`);
    }
  }
  return errors;
}

/**
 * Drift between an authored state and the lanes below it. These warn rather than
 * fail: every one is a shape the estate legitimately passes through while
 * somebody is mid-edit, and a lane marked complete before the state moves is the
 * normal order of events. Note that awaiting-authorization and building are
 * indistinguishable here by design — only a person knows whether a build was
 * authorized, which is why the field is authored in the first place.
 */
export function roadmapWarnings(data, source = "roadmap") {
  if (!data || typeof data !== "object") return [];
  const warnings = [];
  const items = itemList(data);
  const state = data.deliveryState;
  if (state === "shipped" && items.length && !items.some((item) => item?.status === "complete")) {
    warnings.push(`${source}: deliveryState is shipped but no outcome is complete`);
  }
  if (state === "building" && items.length && items.every((item) => item?.status === "complete")) {
    warnings.push(`${source}: deliveryState is building but every outcome is complete`);
  }
  if (state === "designing" && items.some((item) => item?.commit)) {
    warnings.push(`${source}: deliveryState is designing but commit SHAs are recorded`);
  }
  return warnings;
}

function metricCards(metrics) {
  return (metrics || []).map((metric) => `<article class="metric ${escapeHtml(metric.tone || "")}"><strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.label)}</span></article>`).join("");
}

function phaseCards(phases) {
  return phases.map((phase, index) => `<article class="phase ${statusOf(phase.status)}" data-roadmap-status="${statusOf(phase.status)}">
    <span class="phase-number">${escapeHtml(phase.label || `PHASE ${String(index + 1).padStart(2, "0")}`)}</span>
    <h2>${escapeHtml(phase.title)}</h2><p>${escapeHtml(phase.summary || "")}</p>
    <span class="pill ${statusOf(phase.status)}">${escapeHtml(phase.detail || statusLabel(phase.status))}</span>
  </article>`).join("");
}

function agentCards(agents) {
  if (!agents?.length) return '<p class="empty">No implementation agents are active.</p>';
  return agents.map((agent) => `<article class="agent"><span class="agent-mark">${escapeHtml(agent.mark || agent.name?.slice(0, 2).toUpperCase() || "A")}</span><div><h3>${statusOf(agent.status) === "active" ? '<i class="pulse"></i>' : ""}${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.detail || agent.focus || "")}</p>${agent.model ? `<small>${escapeHtml(agent.model)}</small>` : ""}</div></article>`).join("");
}

function guardrailCards(guardrails) {
  return (guardrails || []).map((guardrail) => `<article class="guard"><span>${escapeHtml(guardrail.icon || "✓")}</span><div><strong>${escapeHtml(guardrail.title)}</strong><p>${escapeHtml(guardrail.detail || "")}</p></div></article>`).join("");
}

function laneCards(lanes, phases = []) {
  if (!lanes.length) {
    return '<p class="empty panel">No implementation lanes yet. This workspace has not closed its design.</p>';
  }
  const programmes = [...new Set(phases.map((phase) => phase?.sourceFinalReview).filter(Boolean))];
  if (programmes.length > 1) {
    const programmeOf = (lane) => phases.find((phase) => phase.id === lane.phase)?.sourceFinalReview;
    return programmes.map((programme) => {
      const owned = lanes.filter((lane) => programmeOf(lane) === programme);
      if (!owned.length) return "";
      const titles = phases.filter((phase) => phase.sourceFinalReview === programme);
      return `<section class="programme"><div class="kicker">Authorized by ${escapeHtml(programme)}</div><h2>${escapeHtml(titles[0]?.programmeTitle || titles[0]?.title || programme)}</h2>${laneCards(owned)}</section>`;
    }).join("") + (() => {
      const orphans = lanes.filter((lane) => !programmeOf(lane));
      return orphans.length ? `<section class="programme"><div class="kicker">Unattributed</div>${laneCards(orphans)}</section>` : "";
    })();
  }
  return lanes.map((lane) => `<details class="lane" data-roadmap-status="${statusOf(lane.status)}" ${lane.open || lane.status === "active" || lane.status === "blocked" ? "open" : ""}>
    <summary><span class="lane-mark">${escapeHtml(lane.label || lane.id)}</span><div><h3>${escapeHtml(lane.title)}</h3><p>${escapeHtml(lane.summary || "")}</p></div><span class="pill ${statusOf(lane.status)}">${escapeHtml(lane.detail || (lane.commit ? `${statusLabel(lane.status)} · ${lane.commit}` : statusLabel(lane.status)))}</span></summary>
    <div class="lane-items">${lane.items.map((item) => `<article class="outcome"><code>${escapeHtml(item.id)}</code><div><strong>${escapeHtml(item.title)}</strong>${item.evidence ? `<p>${escapeHtml(item.evidence)}</p>` : ""}</div><span class="pill ${statusOf(item.status)}">${escapeHtml(item.detail || statusLabel(item.status))}</span><code class="commit">${escapeHtml(item.commit || "—")}</code></article>`).join("")}</div>
  </details>`).join("");
}

function ledgerRows(ledger, lanes) {
  const rows = ledger?.length ? ledger : (lanes || []).flatMap((lane) => lane.items.filter((item) => item.commit).map((item) => ({ scope: item.id, status: item.status, commit: item.commit, title: item.title, evidence: item.evidence })));
  return rows.map((row) => `<tr><td><code>${escapeHtml(row.scope || row.id)}</code></td><td><span class="pill ${statusOf(row.status)}">${statusLabel(row.status)}</span></td><td><code>${escapeHtml(row.commit || "—")}</code></td><td>${escapeHtml(row.title || row.outcome || "")}</td><td>${escapeHtml(row.evidence || "")}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">Commits will appear here as outcomes land.</td></tr>';
}

export function renderRoadmap(data) {
  const errors = validateRoadmap(data);
  if (errors.length) throw new Error(`Invalid roadmap:\n${errors.join("\n")}`);
  const focus = data.focus || {};
  const phases = phaseList(data);
  const lanes = laneList(data);
  const state = deliveryStateOf(data);
  const counts = roadmapCounts(data);
  const progress = Math.max(0, Math.min(100, Number(focus.progress ?? (counts.outcomes ? Math.round((counts.integrated / counts.outcomes) * 100) : 0))));
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Not yet recorded";
  const sourceReviews = Array.isArray(data.sourceReviews) ? data.sourceReviews : [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.title)}</title><style>
:root{color-scheme:light;--ink:#14251f;--muted:#65746e;--paper:#f2efe7;--card:#fffdf8;--line:#d9d6cc;--green:#146b4b;--green-soft:#dcece3;--yellow:#f0d557;--yellow-soft:#fff3ba;--blue:#3159a4;--blue-soft:#e3eaf8;--red:#a73b34;--red-soft:#fae5e2;--grey:#ebe9e3;--shadow:0 18px 48px rgba(20,37,31,.09)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font:inherit}.shell{max-width:1500px;margin:auto;padding:28px}.hero{position:relative;overflow:hidden;padding:30px;border-radius:24px;color:#fff;background:linear-gradient(130deg,#102c25,#174c3a 62%,#20684d);box-shadow:var(--shadow)}.hero:after{content:"";position:absolute;width:350px;height:350px;right:-110px;top:-190px;border:58px solid rgba(240,213,87,.16);border-radius:50%}.eyebrow,.kicker{text-transform:uppercase;letter-spacing:.13em;font-size:11px;font-weight:850}.eyebrow{display:flex;align-items:center;gap:9px}.live{width:8px;height:8px;border-radius:50%;background:var(--yellow);box-shadow:0 0 0 6px rgba(240,213,87,.13)}h1{position:relative;z-index:1;max-width:920px;margin:22px 0 9px;font-size:clamp(34px,5vw,65px);line-height:.98;letter-spacing:-.055em}.summary{position:relative;z-index:1;max-width:820px;margin:0;color:#cbded6;font-size:17px}.hero-tags{position:relative;z-index:1;display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.branch.state-shipped{border-color:rgba(240,213,87,.5);background:rgba(240,213,87,.18);color:#ffe66f}.branch.state-blocked{border-color:rgba(255,140,130,.5);background:rgba(255,140,130,.16)}.programme{margin-bottom:6px}.programme>h2{margin:2px 0 10px;font-size:20px;letter-spacing:-.03em}.programme .lane{margin-bottom:10px}.lanes>.empty.panel{padding:22px;border:1px dashed var(--line);border-radius:20px;background:var(--card)}.branch{position:relative;z-index:1;display:inline-flex;padding:9px 13px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:rgba(255,255,255,.07);font:650 12px ui-monospace,SFMono-Regular,Menlo,monospace}.metrics{position:relative;z-index:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:28px}.metric{min-height:106px;padding:17px;border:1px solid rgba(255,255,255,.13);border-radius:16px;background:rgba(255,255,255,.1)}.metric strong{display:block;font-size:30px;line-height:1;letter-spacing:-.04em}.metric span{display:block;margin-top:8px;color:#cfe0d9;font-size:12px}.metric.safe strong{color:#ffe66f}.toolbar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:14px;margin:24px 0 14px}.updated{color:var(--muted);font-size:13px}.filters{display:flex;flex-wrap:wrap;gap:8px}.filter{padding:8px 13px;border:1px solid var(--line);border-radius:999px;background:var(--card);cursor:pointer}.filter[aria-pressed=true]{border-color:var(--green);color:#fff;background:var(--green)}.pipeline{display:grid;grid-template-columns:repeat(${Math.max(1, phases.length)},minmax(176px,1fr));min-width:${Math.max(720, phases.length * 190)}px;gap:10px}.pipeline-wrap{overflow:auto;padding:6px 2px 18px}.phase{position:relative;min-height:142px;padding:17px;border:1px solid var(--line);border-radius:18px;background:var(--card);box-shadow:0 6px 22px rgba(20,37,31,.04)}.phase:not(:last-child):after{content:"→";position:absolute;z-index:2;right:-17px;top:59px;width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--paper);font-weight:900}.phase.active{border:2px solid var(--green);background:linear-gradient(150deg,#fffdf8 20%,#e8f3ed)}.phase.blocked{border:2px solid var(--red);background:var(--red-soft)}.phase-number{color:var(--muted);font:850 11px ui-monospace,SFMono-Regular,Menlo,monospace}.phase h2{margin:12px 0 5px;font-size:17px;line-height:1.15}.phase p{margin:0;color:var(--muted);font-size:12px}.pill{display:inline-flex;margin-top:12px;padding:5px 9px;border-radius:999px;font-size:10px;font-weight:850;white-space:nowrap}.pill.active{color:var(--green);background:var(--green-soft)}.pill.complete{color:var(--blue);background:var(--blue-soft)}.pill.blocked{color:var(--red);background:var(--red-soft)}.pill.queued{color:#6e716e;background:var(--grey)}.workbench{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(290px,.75fr);gap:16px}.panel{padding:22px;border:1px solid var(--line);border-radius:20px;background:var(--card);box-shadow:0 10px 32px rgba(20,37,31,.05)}.panel h2{margin:4px 0 5px;font-size:21px;letter-spacing:-.03em}.focus-head{display:flex;justify-content:space-between;align-items:end;gap:18px}.focus-head strong{font-size:34px;line-height:1}.bar{height:12px;margin:15px 0 4px;overflow:hidden;border-radius:99px;background:#e8e6df}.bar span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green),#31a376)}.agent{display:grid;grid-template-columns:48px 1fr;gap:13px;margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}.agent-mark{width:48px;height:48px;display:grid;place-items:center;border-radius:14px;color:#fff;background:var(--green);font-weight:900}.agent h3,.agent p{margin:0}.agent p,.agent small{color:var(--muted);font-size:12px}.pulse{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#24a56f;box-shadow:0 0 0 6px rgba(36,165,111,.12)}.guard{display:flex;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}.guard:last-child{border:0}.guard>span{flex:0 0 27px;height:27px;display:grid;place-items:center;border-radius:8px;background:var(--yellow-soft);font-weight:900}.guard strong,.guard p{display:block;margin:0}.guard p{color:var(--muted);font-size:11px}.lanes{display:grid;gap:12px;margin-top:16px}.lane{overflow:hidden;border:1px solid var(--line);border-radius:17px;background:var(--card)}.lane[open]{box-shadow:0 8px 24px rgba(20,37,31,.05)}summary{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:center;gap:13px;min-height:72px;padding:12px 17px;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}.lane-mark{width:52px;height:40px;display:grid;place-items:center;border-radius:12px;background:var(--yellow-soft);font:900 12px ui-monospace,SFMono-Regular,Menlo,monospace}summary h3,summary p{margin:0}summary p{color:var(--muted);font-size:12px}.lane-items{padding:0 17px 17px}.outcome{display:grid;grid-template-columns:74px minmax(0,1fr) auto minmax(150px,.55fr);gap:10px;align-items:center;padding:11px 8px;border-top:1px solid var(--line);font-size:12px}.outcome>code:first-child{color:var(--green);font-weight:850}.outcome strong,.outcome p{display:block;margin:0}.outcome p{color:var(--muted);font-size:11px}.outcome .pill{margin:0}.commit{color:var(--muted);font-size:11px}.ledger{margin-top:18px;scroll-margin-top:18px}.table-wrap{overflow:auto}table{width:100%;min-width:800px;border-collapse:collapse}th,td{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:12px}th{color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-size:10px}.note{margin-top:14px;padding:13px 15px;border-left:4px solid var(--yellow);border-radius:0 12px 12px 0;background:#fff9dc;color:#5f5c4c;font-size:12px}.empty{color:var(--muted)}[hidden]{display:none!important}footer{display:flex;justify-content:space-between;gap:16px;margin:18px 4px;color:var(--muted);font-size:11px}@media(max-width:900px){.workbench{grid-template-columns:1fr}.outcome{grid-template-columns:64px 1fr auto}.outcome .commit{grid-column:2/-1}}@media(max-width:600px){.shell{padding:14px}.hero{padding:22px 19px;border-radius:18px}.metrics{grid-template-columns:1fr 1fr}summary{grid-template-columns:50px 1fr}summary>.pill{grid-column:2}.outcome{grid-template-columns:55px 1fr}.outcome>.pill,.outcome .commit{grid-column:2}footer{flex-direction:column}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><main class="shell"><header class="hero"><div class="eyebrow"><span class="live"></span>${escapeHtml(data.eyebrow || "Live implementation programme")}</div><h1>${escapeHtml(data.title)}</h1><p class="summary">${escapeHtml(data.summary)}</p><div class="hero-tags"><span class="branch state-${escapeHtml(state)}">${escapeHtml(deliveryStateLabels[state])}</span>${data.branch?.name ? `<span class="branch">branch · ${escapeHtml(data.branch.name)}${data.branch.base ? ` · base ${escapeHtml(data.branch.base)}` : ""}</span>` : ""}${sourceReviews.length ? `<span class="branch">implements · ${sourceReviews.map((id) => escapeHtml(id)).join(" · ")}</span>` : ""}</div><section class="metrics">${metricCards(data.metrics)}</section></header>
<div class="toolbar"><div class="updated">Last update · ${escapeHtml(updated)}${data.updatedNote ? ` · ${escapeHtml(data.updatedNote)}` : ""}</div><div class="filters" role="group" aria-label="Filter roadmap"><button class="filter" data-filter="all" aria-pressed="true">All phases</button><button class="filter" data-filter="active" aria-pressed="false">Active now</button><button class="filter" data-filter="blocked" aria-pressed="false">Blocked</button><button class="filter" data-target="ledger">Commit ledger ↓</button></div></div>
${phases.length ? `<section class="pipeline-wrap"><div class="pipeline">${phaseCards(phases)}</div></section>` : ""}
<section class="workbench"><article class="panel"><div class="kicker">Active delivery</div><div class="focus-head"><div><h2>${escapeHtml(focus.title || "Implementation focus")}</h2><span class="updated">${escapeHtml(focus.summary || "No active focus recorded.")}</span></div><strong>${progress}%</strong></div><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>${agentCards(focus.agents)}</article><aside class="panel"><div class="kicker">Guardrails</div><h2>${escapeHtml(data.guardrailHeading || "Delivery controls")}</h2>${guardrailCards(data.guardrails)}</aside></section>
<section class="lanes">${laneCards(lanes, data.schemaVersion === 2 ? phases : [])}</section><section class="panel ledger" id="ledger"><div class="kicker">Evidence trail</div><h2>Commit ledger</h2><div class="table-wrap"><table><thead><tr><th>Scope</th><th>Status</th><th>Commit</th><th>Outcome</th><th>Evidence</th></tr></thead><tbody>${ledgerRows(data.ledger, lanes)}</tbody></table></div>${data.note ? `<p class="note">${escapeHtml(data.note)}</p>` : ""}</section><footer><span>Assistant Workspace · reusable roadmap artifact v${data.schemaVersion === 2 ? "2" : "1"}</span><span>${escapeHtml(data.footer || "Update structured roadmap JSON as implementation evidence lands.")}</span></footer></main><script>
const controls=[...document.querySelectorAll('[data-filter]')];const filter=(value)=>{controls.forEach((button)=>button.setAttribute('aria-pressed',String(button.dataset.filter===value)));document.querySelectorAll('[data-roadmap-status]').forEach((node)=>{node.hidden=value!=='all'&&node.dataset.roadmapStatus!==value});};controls.forEach((button)=>button.addEventListener('click',()=>filter(button.dataset.filter)));document.querySelector('[data-target="ledger"]')?.addEventListener('click',()=>document.querySelector('#ledger')?.scrollIntoView({behavior:'smooth'}));
</script></body></html>`;
}
