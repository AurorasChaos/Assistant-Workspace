import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const [projectId, workspaceId, suppliedTitle] = process.argv.slice(2);
if (!idPattern.test(projectId || "") || !idPattern.test(workspaceId || "")) {
  throw new Error("usage: npm run workspace:create -- <project-id> <workspace-id> [title]");
}

const projectsRoot = resolve(process.env.REVIEW_PROJECTS_ROOT || "projects");
const projectDirectory = resolve(projectsRoot, projectId);
const workspaceDirectory = resolve(projectDirectory, "reviews", workspaceId);
if (!workspaceDirectory.startsWith(`${projectDirectory}/`)) throw new Error("invalid workspace path");

const title = suppliedTitle || workspaceId.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
await mkdir(workspaceDirectory, { recursive: true });
await writeFile(resolve(workspaceDirectory, "workspace.json"), `${JSON.stringify({
  schemaVersion: 1,
  id: workspaceId,
  title,
  summary: `${title} review rounds and artifacts.`,
  order: 100,
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`Created workspace ${projectId}/${workspaceId} at ${workspaceDirectory}\n`);
