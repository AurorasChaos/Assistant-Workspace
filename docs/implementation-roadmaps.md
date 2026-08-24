# Reusable implementation roadmaps

An implementation roadmap is a structured Assistant Workspace artifact, not a hand-edited HTML page. Agents update one JSON file while the engine supplies the visual pipeline, active-agent panel, guardrails, detailed outcomes, filters and commit ledger.

Create one inside an existing review—normally the accepted Final Review—using:

```bash
REVIEW_PROJECTS_ROOT=~/.local/share/assistant-workspace/projects \
  npm run roadmap:create -- atlas billing-workspace final-review
```

The complete form is:

```text
npm run roadmap:create -- <project-id> <workspace-id> <review-id> [roadmap-id] [title]
```

The command creates `artifacts/<roadmap-id>.json` and adds a `format: "roadmap"` artifact entry to the review manifest. The daemon discovers it on the next request; no restart or separate port is needed.

## Update contract

Keep these fields current whenever work starts, blocks, lands or verifies:

- `updatedAt` and `updatedNote` describe the latest material change.
- `metrics` provide the headline programme counts.
- `phases` show dependency order and the overall `queued`, `active`, `blocked` or `complete` state.
- `focus.agents` lists currently active agents, their model and bounded responsibility.
- `focus.progress` is an integer from 0 to 100.
- `lanes[].items` are the source of truth for major and minor outcomes.
- `commit` records the final integration SHA and concise commit name once an outcome lands.
- `evidence` records tests, typechecks, reviews or other completion proof.
- `ledger` is optional. When omitted or empty, the renderer derives it from lane items that have commits.

Do not mark an item complete merely because an agent branch contains a commit. Mark it complete after integration and proportionate verification, and record the integration SHA—not only the source-agent SHA.

## Agent ownership

Several agents can contribute to one roadmap, but appoint one integration/orchestration owner for the JSON file. Other agents should report status, evidence and SHAs to that owner rather than editing the same file concurrently. This keeps the roadmap live without turning it into a merge-conflict hotspot.

## Artifact manifest

The review manifest entry has this shape:

```json
{
  "id": "implementation-roadmap",
  "role": "implementation-roadmap",
  "title": "Billing workspace implementation roadmap",
  "shortTitle": "Live roadmap",
  "description": "Continuously updated status, evidence and commits.",
  "format": "roadmap",
  "file": "implementation-roadmap.json"
}
```

`npm run validate` validates roadmap structure. Local serving renders the JSON on request, and `npm run build:demo` renders it into the static export.
