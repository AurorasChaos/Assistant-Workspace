import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const argv = process.argv.slice(2);
const contentRootFlag = argv.indexOf("--content-root");
const contentRoot = contentRootFlag === -1 ? "reviews" : argv[contentRootFlag + 1];
if (contentRootFlag !== -1) argv.splice(contentRootFlag, 2);
if (!contentRoot) throw new Error("--content-root needs a path");
const [id, suppliedTitle] = argv;

if (!idPattern.test(id || "")) {
  throw new Error("usage: npm run project:create -- <kebab-case-id> [title] [--content-root <path>]");
}

const projectsRoot = resolve(process.env.REVIEW_PROJECTS_ROOT || "projects");
const directory = resolve(projectsRoot, id);
if (directory === projectsRoot || !directory.startsWith(`${projectsRoot}/`)) throw new Error("invalid project path");

const title = suppliedTitle || id.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
if (contentRoot === "reviews") await mkdir(resolve(directory, "reviews"), { recursive: true });
await mkdir(resolve(directory, "state"), { recursive: true });
await writeFile(resolve(directory, "project.json"), `${JSON.stringify({
  schemaVersion: 1,
  id,
  title,
  summary: `${title} review workspaces.`,
  order: 100,
  contentRoot,
  stateRoot: "state",
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`Created project ${id} at ${directory}\n`);
