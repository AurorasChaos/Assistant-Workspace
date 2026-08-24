# Assistant Workspace agent instructions

## One local service

- Use the existing Assistant Workspace service at `http://127.0.0.1:8777/`.
- Do not start a second server or choose another port for ordinary review work.
- The user service is `assistant-workspace.service`; inspect it with `systemctl --user status assistant-workspace`.

## Organise by durable project

Every piece of work belongs to a project namespace, not an agent namespace:

```text
projects/<project>/reviews/<workspace>/<round>/
```

Examples:

- `atlas/billing-workspace`
- `beacon/field-operations`
- `harbour/rollout-planning`

Agents collaborate inside the relevant project/workspace and own disjoint round, mock, or artifact files. Never create a top-level folder named after an agent.

Stable local routes are:

```text
/projects/<project>/groups/<workspace>/
/projects/<project>/groups/<workspace>/reviews/<round>/
```

## Scaffold and validate

The system service uses `REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects`.

```bash
REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects npm run project:create -- <project-id> "Project title"
REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects npm run workspace:create -- <project-id> <workspace-id> "Workspace title"
REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects npm run validate
```

Do not edit generated review state as authored content. Keep private review packs and state outside this public repository.
