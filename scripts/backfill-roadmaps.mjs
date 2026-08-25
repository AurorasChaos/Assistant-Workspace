// Move every implementation roadmap out of the Final Review it was authored in
// and onto the workspace that owns it.
//
// Dry-runs by default: the first thing anyone does with a migration script is run
// it to see what it says. `--write` performs the plan, `--check` exits non-zero if
// anything is still unmigrated. It never commits — ready-reviews is a content
// repository whose commits are authored deliberately.
//
//   npm run roadmap:backfill                 plan only
//   npm run roadmap:backfill -- --write      perform it
//   npm run roadmap:backfill -- --check      is the estate migrated?

import { access, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deliveryStateOf, validateRoadmap } from "../lib/roadmap.mjs";

const appRoot = new URL("..", import.meta.url).pathname;
const projectsRoot = process.env.REVIEW_PROJECTS_ROOT ? resolve(process.env.REVIEW_PROJECTS_ROOT) : null;
if (!projectsRoot) throw new Error("REVIEW_PROJECTS_ROOT must name the projects directory");

const flags = new Set(process.argv.slice(2));
const write = flags.has("--write");
const check = flags.has("--check");
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

async function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Merge two or more roadmaps into one file, in review order.
 *
 * A lane id present in more than one source is the same lane carried forward, so
 * the later source's version supersedes the earlier in place. A lane id present in
 * only one source is unique work and survives untouched. Phases follow the same
 * rule, and every phase is stamped with the Final Review that authorized it, so a
 * merged file can still say which programme each lane belongs to.
 *
 * This is why the rule is a merge rather than a choice: club-payments' second
 * roadmap contains all seven of its first one's lanes, but finance-workspace's two
 * share none, and taking either file alone would discard the other's record.
 */
function mergeRoadmaps(sources) {
  const phases = [];
  const phaseIndex = new Map();
  const lanes = [];
  const laneIndex = new Map();
  const ledger = [];
  const seenLedger = new Set();

  for (const { id: reviewId, roadmap } of sources) {
    const firstPhaseId = (roadmap.phases || [])[0]?.id ?? null;
    for (const phase of roadmap.phases || []) {
      const stamped = { ...phase, sourceFinalReview: reviewId, programmeTitle: roadmap.title };
      if (phaseIndex.has(phase.id)) phases[phaseIndex.get(phase.id)] = stamped;
      else { phaseIndex.set(phase.id, phases.length); phases.push(stamped); }
    }
    for (const lane of roadmap.lanes || []) {
      const attributed = { ...lane, phase: firstPhaseId ?? lane.phase };
      if (laneIndex.has(lane.id)) lanes[laneIndex.get(lane.id)] = attributed;
      else { laneIndex.set(lane.id, lanes.length); lanes.push(attributed); }
    }
    for (const row of roadmap.ledger || []) {
      const key = `${row.scope || row.id}|${row.commit}`;
      if (seenLedger.has(key)) continue;
      seenLedger.add(key);
      ledger.push(row);
    }
  }

  const latest = sources[sources.length - 1].roadmap;
  const merged = { ...latest, phases, lanes };
  if (ledger.length) merged.ledger = ledger;
  return merged;
}

function sourceReviewsFor(reviews) {
  const ordered = [];
  for (const review of reviews) {
    for (const id of review.manifest.sourceReviews || []) if (!ordered.includes(id)) ordered.push(id);
    if (!ordered.includes(review.id)) ordered.push(review.id);
  }
  return ordered;
}

const plan = [];
const redirects = {};
let unmigrated = 0;

for (const projectEntry of (await readdir(projectsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!projectEntry.isDirectory() || !idPattern.test(projectEntry.name)) continue;
  const projectPath = join(projectsRoot, projectEntry.name);
  if (!(await exists(join(projectPath, "project.json")))) continue;
  const project = await readJson(join(projectPath, "project.json"));
  const contentRoot = resolve(projectPath, project.contentRoot || "reviews");
  if (!(await exists(contentRoot))) continue;

  for (const workspaceEntry of (await readdir(contentRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!workspaceEntry.isDirectory() || !idPattern.test(workspaceEntry.name)) continue;
    const workspacePath = join(contentRoot, workspaceEntry.name);
    if (!(await exists(join(workspacePath, "workspace.json")))) continue;
    const workspace = await readJson(join(workspacePath, "workspace.json"));
    const label = `${project.id}/${workspace.id}`;
    const roadmapPath = join(workspacePath, "roadmap.json");
    const hasRoadmap = await exists(roadmapPath);

    // Which reviews still carry a roadmap artifact, in review order.
    const carriers = [];
    for (const reviewEntry of await readdir(workspacePath, { withFileTypes: true })) {
      if (!reviewEntry.isDirectory() || !idPattern.test(reviewEntry.name)) continue;
      const reviewPath = join(reviewEntry.name === "" ? workspacePath : join(workspacePath, reviewEntry.name), "review.json");
      if (!(await exists(reviewPath))) continue;
      const manifest = await readJson(reviewPath);
      const artifact = (manifest.artifacts || []).find((entry) => entry.format === "roadmap");
      if (!artifact) continue;
      carriers.push({
        id: reviewEntry.name, manifest, reviewPath, artifact,
        order: Number(manifest.order || 0),
        roadmap: await readJson(join(workspacePath, reviewEntry.name, "artifacts", artifact.file)),
        artifactPath: join(workspacePath, reviewEntry.name, "artifacts", artifact.file),
      });
    }
    carriers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

    for (const carrier of carriers) {
      redirects[`/projects/${project.id}/groups/${workspace.id}/reviews/${carrier.id}/artifacts/${carrier.artifact.id}`] =
        `/projects/${project.id}/groups/${workspace.id}/roadmap`;
    }

    if (!carriers.length) {
      if (hasRoadmap) { plan.push({ label, action: "skip", detail: "roadmap.json already present" }); continue; }
      unmigrated += 1;
      const seeded = {
        schemaVersion: 2,
        title: workspace.title,
        summary: workspace.summary,
        deliveryState: "designing",
        sourceReviews: (await readdir(workspacePath, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && idPattern.test(entry.name)).map((entry) => entry.name).sort(),
        updatedAt: new Date().toISOString(),
      };
      if (!seeded.sourceReviews.length) delete seeded.sourceReviews;
      plan.push({ label, action: "seed", detail: "designing, 0 lanes", target: roadmapPath, contents: seeded });
      continue;
    }

    unmigrated += 1;
    const merged = carriers.length === 1 ? { ...carriers[0].roadmap } : mergeRoadmaps(carriers);
    merged.schemaVersion = 2;
    merged.sourceReviews = sourceReviewsFor(carriers);
    merged.deliveryState = merged.deliveryState || deliveryStateOf(merged);

    const counts = {
      lanes: (merged.lanes || []).length,
      outcomes: (merged.lanes || []).reduce((total, lane) => total + (lane.items || []).length, 0),
      commits: (merged.lanes || []).flatMap((lane) => lane.items || []).filter((item) => item.commit).length,
    };
    plan.push({
      label,
      action: carriers.length === 1 ? "move" : "merge",
      detail: carriers.length === 1
        ? `${carriers[0].id} → roadmap.json · ${counts.lanes} lanes, ${counts.outcomes} outcomes, ${counts.commits} SHAs · ${merged.deliveryState}`
        : `${carriers.map((c) => c.id).join(" + ")} → roadmap.json · ${counts.lanes} lanes, ${counts.outcomes} outcomes, ${counts.commits} SHAs · ${merged.deliveryState}`,
      sources: carriers.map((c) => ({ id: c.id, lanes: (c.roadmap.lanes || []).length, outcomes: (c.roadmap.lanes || []).reduce((t, l) => t + (l.items || []).length, 0) })),
      target: roadmapPath,
      contents: merged,
      strip: carriers.map((c) => ({ reviewPath: c.reviewPath, manifest: c.manifest, artifactId: c.artifact.id, artifactPath: c.artifactPath })),
    });
  }
}

// Validate before writing anything: a migration that produces an invalid estate
// should say so while it is still a plan.
const invalid = [];
for (const entry of plan) {
  if (!entry.contents) continue;
  const errors = validateRoadmap(entry.contents, `${entry.label}/roadmap.json`);
  if (errors.length) invalid.push(...errors);
}

const width = Math.max(...plan.map((entry) => entry.label.length), 10);
process.stdout.write(`${write ? "" : check ? "" : "DRY RUN — nothing is written. Pass --write to perform this plan.\n\n"}`);
for (const entry of plan) {
  process.stdout.write(`  ${entry.action.padEnd(6)} ${entry.label.padEnd(width)}  ${entry.detail}\n`);
  for (const source of entry.sources || []) {
    if ((entry.sources || []).length > 1) process.stdout.write(`         ${"".padEnd(width)}  ${source.id}: ${source.lanes} lanes, ${source.outcomes} outcomes\n`);
  }
}

if (invalid.length) {
  process.stderr.write(`\n${invalid.map((error) => `- ${error}`).join("\n")}\n`);
  process.stderr.write("\nRefusing to write: the plan does not produce a valid estate.\n");
  process.exitCode = 1;
} else if (check) {
  process.stdout.write(`\n  ${unmigrated ? `${unmigrated} workspace(s) still unmigrated` : "estate is fully migrated"}\n`);
  process.exitCode = unmigrated ? 1 : 0;
} else if (!write) {
  const counts = plan.reduce((totals, entry) => ({ ...totals, [entry.action]: (totals[entry.action] || 0) + 1 }), {});
  process.stdout.write(`\n  ${plan.length} workspaces: ${Object.entries(counts).map(([action, n]) => `${n} ${action}`).join(", ")}\n`);
  process.stdout.write(`  ${Object.keys(redirects).length} redirect(s) would be written to engine/redirects.json\n`);
} else {
  let wrote = 0;
  let edited = 0;
  for (const entry of plan) {
    if (!entry.contents) continue;
    await writeAtomic(entry.target, jsonText(entry.contents));
    wrote += 1;
    for (const source of entry.strip || []) {
      const artifacts = (source.manifest.artifacts || []).filter((artifact) => artifact.id !== source.artifactId);
      await writeAtomic(source.reviewPath, jsonText({ ...source.manifest, artifacts }));
      await rm(source.artifactPath, { force: true });
      edited += 1;
    }
  }
  // Merge rather than replace: after the first run the carriers are gone, so a
  // second run computes no redirects and would otherwise erase the table.
  const redirectsPath = join(appRoot, "engine", "redirects.json");
  const existing = (await exists(redirectsPath)) ? await readJson(redirectsPath) : {};
  const combined = { ...existing, ...redirects };
  await writeAtomic(redirectsPath, jsonText(combined));
  process.stdout.write(`\n  wrote ${wrote} roadmap.json\n  edited ${edited} review.json\n  engine/redirects.json holds ${Object.keys(combined).length} entries (${Object.keys(redirects).filter((key) => !(key in existing)).length} new)\n`);
  process.stdout.write("\n  Nothing committed. Read the diff, then commit.\n");
}
