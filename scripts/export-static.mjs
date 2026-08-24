import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = resolve(process.env.REVIEW_CONTENT_ROOT || join(appRoot, "reviews"));
const requestedOutput = process.argv[2] || join(appRoot, "_site");
const outputRoot = resolve(requestedOutput);
const safePrefix = `${appRoot}${sep}`;
if (!outputRoot.startsWith(safePrefix) || outputRoot === appRoot) throw new Error("Static output must be a dedicated directory inside the repository");

const temporary = await mkdtemp(join(tmpdir(), "assistant-workspace-export-"));
const port = 20000 + (process.pid % 1000);
const server = spawn("node", ["server.mjs"], {
  cwd: appRoot,
  env: { ...process.env, REVIEW_HOST: "127.0.0.1", REVIEW_PORT: String(port), REVIEW_CONTENT_ROOT: contentRoot, REVIEW_DATA_ROOT: join(temporary, "state") },
  stdio: "ignore",
});

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
  }
  throw new Error("Local export server did not start");
}

async function fetchText(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`Export fetch failed: ${response.status} ${path}`);
  return response.text();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

try {
  await waitForServer();
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(join(appRoot, "engine"), join(outputRoot, "assets"), { recursive: true });
  await writeFile(join(outputRoot, ".nojekyll"), "", "utf8");
  await writeFile(join(outputRoot, "index.html"), await fetchText("/"), "utf8");

  const workspaceEntries = await readdir(contentRoot, { withFileTypes: true });
  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspaceDirectory = join(contentRoot, workspaceEntry.name);
    let workspace;
    try { workspace = await readJson(join(workspaceDirectory, "workspace.json")); } catch { continue; }
    const workspaceOutput = join(outputRoot, "groups", workspace.id);
    await mkdir(workspaceOutput, { recursive: true });
    await writeFile(join(workspaceOutput, "index.html"), await fetchText(`/groups/${encodeURIComponent(workspace.id)}/`), "utf8");

    const reviewEntries = await readdir(workspaceDirectory, { withFileTypes: true });
    for (const reviewEntry of reviewEntries) {
      if (!reviewEntry.isDirectory()) continue;
      const reviewDirectory = join(workspaceDirectory, reviewEntry.name);
      let review;
      try { review = await readJson(join(reviewDirectory, "review.json")); } catch { continue; }
      const reviewOutput = join(workspaceOutput, "reviews", review.id);
      await mkdir(reviewOutput, { recursive: true });
      await writeFile(join(reviewOutput, "index.html"), await fetchText(`/groups/${encodeURIComponent(workspace.id)}/reviews/${encodeURIComponent(review.id)}/`), "utf8");
      await writeFile(join(reviewOutput, "review.json"), `${JSON.stringify({ ...review, workspace: { id: workspace.id, title: workspace.title }, staticDemo: true }, null, 2)}\n`, "utf8");

      for (const mock of review.mocks || []) {
        const sourceDirectory = join(workspaceDirectory, mock.sourceReview || review.id, "mocks");
        await cp(sourceDirectory, join(reviewOutput, "mocks", mock.id), { recursive: true });
      }
      for (const artifact of review.artifacts || []) {
        await mkdir(join(reviewOutput, "artifacts"), { recursive: true });
        if (artifact.format === "roadmap") {
          await writeFile(
            join(reviewOutput, "artifacts", artifact.id),
            await fetchText(`/groups/${encodeURIComponent(workspace.id)}/reviews/${encodeURIComponent(review.id)}/artifacts/${encodeURIComponent(artifact.id)}`),
            "utf8",
          );
        } else {
          await copyFile(join(reviewDirectory, "artifacts", artifact.file), join(reviewOutput, "artifacts", artifact.id));
        }
      }
    }
  }
  process.stdout.write(`Static demo exported to ${outputRoot}\n`);
} finally {
  server.kill("SIGTERM");
  await rm(temporary, { recursive: true, force: true });
}
