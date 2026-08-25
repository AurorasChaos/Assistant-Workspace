import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const [projectId, workspaceId, suppliedTitle] = process.argv.slice(2);
if (!idPattern.test(projectId || "") || !idPattern.test(workspaceId || "")) {
  throw new Error("usage: npm run workspace:create -- <project-id> <workspace-id> [title]");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Resolve the content root the same way the server does: from the project
 * manifest. Writing to `<projectsRoot>/<project>/reviews` regardless is how every
 * workspace created after the content moved to its own repository landed
 * somewhere the server never reads.
 */
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

const workspaceDirectory = resolve(contentRoot, workspaceId);
if (!workspaceDirectory.startsWith(`${contentRoot}/`)) throw new Error("invalid workspace path");
try {
  await access(contentRoot);
} catch {
  throw new Error(`content root does not exist: ${contentRoot}`);
}

const title = suppliedTitle || workspaceId.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
const summary = `${title} review rounds and artifacts.`;
await mkdir(workspaceDirectory, { recursive: true });
await writeFile(resolve(workspaceDirectory, "workspace.json"), `${JSON.stringify({
  schemaVersion: 1,
  id: workspaceId,
  title,
  summary,
  order: 100,
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

// Every workspace has a roadmap from the moment it exists, so "where is this up
// to" is answerable before any design closes.
await writeFile(resolve(workspaceDirectory, "roadmap.json"), `${JSON.stringify({
  schemaVersion: 2,
  title,
  summary,
  deliveryState: "designing",
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

process.stdout.write(`Created workspace ${projectId}/${workspaceId} at ${workspaceDirectory}\n`);
