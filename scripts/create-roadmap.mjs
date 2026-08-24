import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const [projectId, workspaceId, reviewId, suppliedId = "implementation-roadmap", suppliedTitle] = process.argv.slice(2);
if (![projectId, workspaceId, reviewId, suppliedId].every((value) => idPattern.test(value || ""))) {
  throw new Error("usage: npm run roadmap:create -- <project-id> <workspace-id> <review-id> [roadmap-id] [title]");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

let contentRoot;
if (process.env.REVIEW_PROJECTS_ROOT) {
  const projectDirectory = resolve(process.env.REVIEW_PROJECTS_ROOT, projectId);
  const project = await readJson(join(projectDirectory, "project.json"));
  if (project.id !== projectId) throw new Error(`project manifest does not match ${projectId}`);
  contentRoot = resolve(projectDirectory, project.contentRoot || "reviews");
} else {
  if (projectId !== "shared") throw new Error("project-id must be shared when REVIEW_PROJECTS_ROOT is not configured");
  contentRoot = resolve(process.env.REVIEW_CONTENT_ROOT || new URL("../reviews", import.meta.url).pathname);
}

const reviewDirectory = resolve(contentRoot, workspaceId, reviewId);
if (!reviewDirectory.startsWith(`${contentRoot}/`)) throw new Error("invalid review path");
const reviewPath = join(reviewDirectory, "review.json");
const review = await readJson(reviewPath);
if (review.id !== reviewId) throw new Error(`review manifest does not match ${reviewId}`);
if ((review.artifacts || []).some((artifact) => artifact.id === suppliedId)) throw new Error(`artifact ${suppliedId} already exists`);

const title = suppliedTitle || `${workspaceId.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ")} implementation roadmap`;
const file = `${suppliedId}.json`;
const roadmap = {
  schemaVersion: 1,
  title,
  eyebrow: "Live implementation programme · updated as commits land",
  summary: "A dependency-ordered implementation plan with live agent ownership, evidence and commit traceability.",
  updatedAt: new Date().toISOString(),
  updatedNote: "Roadmap created",
  branch: { name: "feature/replace-me", base: "record-base-sha" },
  metrics: [
    { value: "0 / 1", label: "Phases complete" },
    { value: "0 / 1", label: "Outcomes complete" },
    { value: "0", label: "Agents active" },
    { value: "0", label: "Production changes", tone: "safe" },
  ],
  phases: [
    { id: "foundation", label: "PHASE 01", title: "Foundation", summary: "Contracts, boundaries and integration seams", status: "queued", detail: "Queued" },
  ],
  focus: { title: "Foundation", summary: "Assign the first implementation lane.", progress: 0, agents: [] },
  guardrailHeading: "Delivery controls",
  guardrails: [
    { icon: "0", title: "No unapproved production changes", detail: "Keep rollout and external effects behind explicit authorization." },
    { icon: "✓", title: "Evidence before complete", detail: "Record verification and the integration commit for every outcome." },
  ],
  lanes: [
    {
      id: "lane-foundation",
      label: "P1",
      title: "Foundation",
      summary: "Replace this scaffold with the first implementation lane.",
      status: "queued",
      items: [
        { id: "P1.1", title: "Define the first verifiable outcome", status: "queued", commit: "" },
      ],
    },
  ],
  ledger: [],
  note: "Keep this roadmap current as work starts, blocks, integrates and verifies.",
};

await mkdir(join(reviewDirectory, "artifacts"), { recursive: true });
await writeFile(join(reviewDirectory, "artifacts", file), `${JSON.stringify(roadmap, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
review.artifacts = [...(review.artifacts || []), {
  id: suppliedId,
  role: "implementation-roadmap",
  title,
  shortTitle: "Live roadmap",
  description: "Continuously updated implementation status, agent ownership, verification evidence and commit ledger.",
  format: "roadmap",
  file,
}];
await writeAtomic(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
process.stdout.write(`Created roadmap ${projectId}/${workspaceId}/${reviewId}/${suppliedId}\nData: ${join(reviewDirectory, "artifacts", file)}\n`);
