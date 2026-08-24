import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateRoadmap } from "../lib/roadmap.mjs";

const contentRoot = resolve(process.env.REVIEW_CONTENT_ROOT || new URL("../reviews", import.meta.url).pathname);
const projectsRoot = process.env.REVIEW_PROJECTS_ROOT ? resolve(process.env.REVIEW_PROJECTS_ROOT) : null;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const errors = [];
let workspaceCount = 0;
let reviewCount = 0;
let projectCount = 0;

async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { errors.push(`${path}: ${error.message}`); return null; }
}

function unique(items, label, path) {
  const ids = items.map((item) => item?.id);
  for (const id of new Set(ids)) if (ids.filter((value) => value === id).length > 1) errors.push(`${path}: duplicate ${label} id ${id}`);
}

const projectSources = [];
if (projectsRoot) {
  for (const projectEntry of await readdir(projectsRoot, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(projectsRoot, projectEntry.name);
    const project = await json(join(projectPath, "project.json"));
    if (!project) continue;
    projectCount += 1;
    if (!idPattern.test(projectEntry.name) || project.id !== projectEntry.name) errors.push(`${projectPath}: folder and project id must match kebab-case`);
    if (!project.title || !project.summary) errors.push(`${projectPath}: project title and summary are required`);
    projectSources.push({ id: project.id, contentRoot: resolve(projectPath, project.contentRoot || "reviews") });
  }
} else {
  projectCount = 1;
  projectSources.push({ id: "shared", contentRoot });
}

for (const projectSource of projectSources) {
for (const workspaceEntry of await readdir(projectSource.contentRoot, { withFileTypes: true })) {
  if (!workspaceEntry.isDirectory()) continue;
  const workspacePath = join(projectSource.contentRoot, workspaceEntry.name);
  const workspace = await json(join(workspacePath, "workspace.json"));
  if (!workspace) continue;
  workspaceCount += 1;
  if (!idPattern.test(workspaceEntry.name) || workspace.id !== workspaceEntry.name) errors.push(`${workspacePath}: folder and workspace id must match kebab-case`);
  if (!workspace.title || !workspace.summary) errors.push(`${workspacePath}: title and summary are required`);
  // Named reviewers gate hosted access (ADMIN is implicit). A malformed list must
  // fail here rather than silently denying everyone at the proxy.
  if (workspace.reviewers !== undefined) {
    if (!Array.isArray(workspace.reviewers) || workspace.reviewers.some((entry) => typeof entry !== "string" || !entry.includes("@"))) {
      errors.push(`${workspacePath}: reviewers must be an array of email addresses`);
    }
  }

  for (const reviewEntry of await readdir(workspacePath, { withFileTypes: true })) {
    if (!reviewEntry.isDirectory()) continue;
    const reviewPath = join(workspacePath, reviewEntry.name);
    const review = await json(join(reviewPath, "review.json"));
    if (!review) continue;
    reviewCount += 1;
    if (!idPattern.test(reviewEntry.name) || review.id !== reviewEntry.name) errors.push(`${reviewPath}: folder and review id must match kebab-case`);
    if (!review.title || !review.summary || !review.intro) errors.push(`${reviewPath}: title, summary and intro are required`);
    if (!Array.isArray(review.mocks) || !review.mocks.length) errors.push(`${reviewPath}: at least one mock is required`);
    if (!Array.isArray(review.questions)) errors.push(`${reviewPath}: questions must be an array`);
    unique(review.mocks || [], "mock", reviewPath);
    unique(review.questions || [], "question", reviewPath);
    for (const mock of review.mocks || []) {
      if (!idPattern.test(mock.id || "") || !mock.title || !mock.file) errors.push(`${reviewPath}: every mock requires a kebab-case id, title and file`);
      const mockReviewPath = mock.sourceReview ? join(workspacePath, mock.sourceReview) : reviewPath;
      try { await access(join(mockReviewPath, "mocks", mock.file)); } catch { errors.push(`${reviewPath}: missing mock file ${mock.file} in ${mock.sourceReview || review.id}`); }
    }
    for (const question of review.questions || []) {
      if (!idPattern.test(question.id || "") || !question.title || !Array.isArray(question.options) || question.options.length < 2) errors.push(`${reviewPath}: every question requires an id, title and at least two options`);
      unique(question.options || [], "option", `${reviewPath}#${question.id}`);
      if (question.recommended && !(question.options || []).some((option) => option.id === question.recommended)) errors.push(`${reviewPath}#${question.id}: recommended must name an option id`);
    }
    for (const artifact of review.artifacts || []) {
      if (!idPattern.test(artifact.id || "") || !artifact.title || !artifact.file) errors.push(`${reviewPath}: every artifact requires a kebab-case id, title and file`);
      try { await access(join(reviewPath, "artifacts", artifact.file)); } catch { errors.push(`${reviewPath}: missing artifact file ${artifact.file}`); }
      if (artifact.format === "roadmap") {
        const roadmapPath = join(reviewPath, "artifacts", artifact.file);
        const roadmap = await json(roadmapPath);
        if (roadmap) errors.push(...validateRoadmap(roadmap, roadmapPath));
      }
    }
    if (review.kind === "final") {
      if (!Array.isArray(review.sourceReviews) || !review.sourceReviews.length) errors.push(`${reviewPath}: Final Review requires sourceReviews`);
      if (!(review.artifacts || []).some((artifact) => artifact.role === "final-spec")) errors.push(`${reviewPath}: Final Review requires a final-spec artifact`);
      const coveredMocks = new Set((review.mocks || []).map((mock) => `${mock.sourceReview}/${mock.sourceMock}`));
      const coveredDecisions = new Set((review.decisions || []).map((decision) => `${decision.sourceReview}/${decision.sourceQuestion}`));
      unique(review.decisions || [], "settled decision", reviewPath);
      for (const sourceId of review.sourceReviews || []) {
        const sourcePath = join(workspacePath, sourceId, "review.json");
        const source = await json(sourcePath);
        if (!source) continue;
        for (const mock of source.mocks || []) if (!coveredMocks.has(`${sourceId}/${mock.id}`)) errors.push(`${reviewPath}: Final Review does not include mock ${sourceId}/${mock.id}`);
        for (const question of source.questions || []) if (!coveredDecisions.has(`${sourceId}/${question.id}`)) errors.push(`${reviewPath}: Final Review does not record decision ${sourceId}/${question.id}`);
      }
    }
  }
}
}

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${projectCount} project(s), ${workspaceCount} workspace(s) and ${reviewCount} review(s).\n`);
}
