import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "assistant-workspace-projects-"));
const projectsRoot = join(temporary, "projects");
const port = 21000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;

async function publishProject(id, title) {
  const directory = join(projectsRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "project.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    title,
    summary: `${title} dynamic discovery fixture.`,
    contentRoot: resolve(appRoot, "reviews"),
    stateRoot: join(directory, "state"),
  }, null, 2)}\n`, "utf8");
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if (await check()) return; } catch {}
    await new Promise((finish) => setTimeout(finish, 50));
  }
  throw new Error(`${label} timed out`);
}

await publishProject("atlas", "Atlas");
const server = spawn("node", ["server.mjs"], {
  cwd: appRoot,
  env: { ...process.env, REVIEW_HOST: "127.0.0.1", REVIEW_PORT: String(port), REVIEW_PROJECTS_ROOT: projectsRoot },
  stdio: "ignore",
});

try {
  await waitFor(async () => (await fetch(`${baseUrl}/`)).ok, "project server");
  const before = await (await fetch(`${baseUrl}/`)).text();
  if (!before.includes("projects/atlas/groups/example-workspace/") || before.includes("projects/beacon/groups/example-workspace/")) throw new Error("initial project discovery mismatch");

  await publishProject("beacon", "Beacon");
  await waitFor(async () => (await (await fetch(`${baseUrl}/`)).text()).includes("projects/beacon/groups/example-workspace/"), "live project discovery");

  const workspace = await fetch(`${baseUrl}/projects/beacon/groups/example-workspace/`);
  if (!workspace.ok) throw new Error(`dynamic workspace route returned ${workspace.status}`);
  const review = await (await fetch(`${baseUrl}/projects/beacon/groups/example-workspace/reviews/round-1/review.json`)).json();
  if (review.project?.id !== "beacon" || review.workspace?.id !== "example-workspace") throw new Error("dynamic review namespace mismatch");

  process.stdout.write("Project discovery smoke passed: new projects load without a daemon restart.\n");
} finally {
  server.kill("SIGTERM");
  await rm(temporary, { recursive: true, force: true });
}
