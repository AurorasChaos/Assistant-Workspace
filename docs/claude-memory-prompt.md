# Copy-ready Claude memory prompt

Give the following prompt to a Claude agent that has access to this PC:

```text
Create or update a durable memory named “Assistant Workspace on this machine”. Treat the facts below as the canonical local workflow. Read `~/Projects/Assistant-Workspace/AGENTS.md`, `README.md`, `docs/projects.md`, `docs/agents.md`, `docs/authoring.md`, `docs/interactive-mockups.md`, and `docs/final-review.md` before saving the memory. If your memory system supports source links, record those files as the sources.

System location and service
- The reusable public engine repository is `~/Projects/Assistant-Workspace`.
- One persistent user-level systemd service runs it. Do not start another server or allocate another port for normal work.
- Service: `assistant-workspace.service`.
- Check it with `systemctl --user status assistant-workspace.service`.
- Logs: `journalctl --user -u assistant-workspace.service -n 100 --no-pager`.
- Local library: `http://127.0.0.1:8777/`.
- The service binds only to `127.0.0.1` and uses `REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects`.

Durable hierarchy
- Organise content by project, then piece of work: project → workspace → review round/artifact.
- Never create a namespace or folder named after a temporary agent.
- Examples of projects are `atlas`, `beacon`, and `harbour`.
- Examples of workspaces are `atlas/billing-workspace` or `beacon/field-operations`.
- Canonical URLs are `/projects/<project>/groups/<workspace>/` and `/projects/<project>/groups/<workspace>/reviews/<round>/`.
- Legacy `/groups/<workspace>/` URLs work only while the workspace id is unique across all projects; generate and share canonical project URLs.

Live discovery
- The daemon discovers projects, workspaces, rounds and artifacts on every request.
- A valid newly published `project.json` or workspace appears without restarting systemd.
- Do not restart the daemon merely to publish content.

Scaffolding
- From `~/Projects/Assistant-Workspace`, create a project with:
  `REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects npm run project:create -- <project-id> "Project title"`
- Create a piece-of-work workspace with:
  `REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects npm run workspace:create -- <project-id> <workspace-id> "Workspace title"`
- Validate all local projects with:
  `REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects npm run validate`
- Run engine tests with `npm test`; use `npm run test:browser` after engine/UI changes.

Review process
1. Confirm the durable project and piece-of-work workspace before authoring.
2. Create a numbered review round with interactive HTML mockups, authored questions, recommendations/options, and annotation targets.
3. Make mockup controls genuinely interactive so the reviewer can understand connected behavior.
4. Let the human annotate regions, answer recommendations, add their own view, and mark the round complete.
5. Preserve every earlier round and decision. Material new design work creates the next round rather than rewriting accepted history.
6. End with a distinct Final Review containing all accepted mockups, all sourced decisions, resolved feedback, and the final specification artifact.
7. Final Review acceptance closes the design artifact only. It never authorizes implementation. Ask a separate explicit build-authorization question.
8. Once implementation is authorized, add a live visual Roadmap artifact with wave/lane status, verification evidence, risks, and final integration commit SHA/name for each major and minor outcome.
9. Create roadmaps with `npm run roadmap:create -- <project-id> <workspace-id> <review-id>` so they use the reusable structured roadmap renderer. Keep one orchestration owner for its JSON and update it whenever work starts, blocks, integrates or verifies.
9. Update that Roadmap as commits land; do not wait for the reviewer to ask for status.

Parallel-agent ownership
- Several agents may work in one project/workspace, but each must own disjoint round, mock, artifact, or implementation files.
- One integration owner controls the workspace manifest, Final Review, shared contracts, choke points, and merge order.
- Validate the complete workspace after parallel changes; individually green lanes can still fail when composed.

Content and state boundaries
- Private project content and generated reviewer state may live outside the public engine repository through each project’s `contentRoot` and `stateRoot` in `project.json`.
- A project may point at content and state roots that live outside this repository; set them in that project's manifest.
- Do not edit generated state as authored content.
- Do not put secrets, production data, webhook URLs, or sensitive customer material in the public Assistant-Workspace repository or public GitHub Pages demo.
- The local server has no authentication and must remain bound to `127.0.0.1` unless a trusted authenticated reverse proxy is deliberately configured.

Operational behavior
- Before work, open `http://127.0.0.1:8777/` or curl it and confirm the intended project/workspace.
- If the service is unhealthy, inspect systemd status/logs before restarting it.
- Keep the service unit at `~/.config/systemd/user/assistant-workspace.service`; the versioned template is `~/Projects/Assistant-Workspace/systemd/assistant-workspace.service`.
- When you finish creating the memory, report where it was saved, its title, and a concise list of the rules recorded. Do not perform unrelated product implementation merely because this memory was created.
```
