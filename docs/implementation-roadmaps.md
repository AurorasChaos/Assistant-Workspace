# Implementation roadmaps

A roadmap is a first-class file at the workspace root — one per workspace, for the
workspace's whole life:

```text
projects/<project>/reviews/<workspace>/roadmap.json
```

It is served at a stable URL that survives every later Final Review:

```text
/projects/<project>/groups/<workspace>/roadmap
```

Agents update one JSON file while the engine supplies the visual pipeline,
active-agent panel, guardrails, detailed outcomes, filters and commit ledger.

> Roadmaps used to be an artifact of the Final Review that authorized them
> (`<final-review>/artifacts/implementation-roadmap.json`). A workspace that
> reached a second Final Review then carried two, at two URLs, with no marker
> saying which was current. Those URLs still resolve — they redirect permanently
> to the workspace roadmap.

## Creating one

`npm run workspace:create` seeds a roadmap with every new workspace, so
"where is this up to" is answerable before any design closes:

```json
{
  "schemaVersion": 2,
  "title": "Widget review",
  "summary": "Widget review review rounds and artifacts.",
  "deliveryState": "designing"
}
```

For an existing workspace that predates this, `npm run roadmap:backfill` seeds one.

## Delivery state

Five states, authored and validated against the list:

| State | Meaning |
|---|---|
| `designing` | Rounds in progress, or no Final Review yet. |
| `awaiting-authorization` | Design closed, build never authorized. |
| `building` | Authorized and in flight. |
| `shipped` | Integrated and verified. |
| `blocked` | Work stopped on something outside the lane. |

It is **authored rather than derived** because `awaiting-authorization` is a fact
about a human decision. A workspace with twelve designed lanes and no integration
looks identical in the data whether the build was refused or simply has not
started, and only a person knows which. No validator check will ever tell those
two apart — the field exists precisely because the build gate is not derivable.

## Schema

`schemaVersion: 2`. The engine still reads version 1, treating it as one unnamed
programme, so a roadmap written before this change renders unchanged.

| Field | Required | Meaning |
|---|---|---|
| `deliveryState` | yes | One of the five above. |
| `sourceReviews[]` | unless `designing` | Which rounds and Final Reviews this roadmap implements. |
| `phases[].sourceFinalReview` | when the file carries more than one programme | Which Final Review authorized this phase. |
| `lanes[].phase` | when the file carries more than one programme | Which phase a lane belongs to. |

"More than one programme" means more than one distinct
`phases[].sourceFinalReview` — not more than one phase. A roadmap drawing thirteen
pipeline phases against a single Final Review is one programme and needs no
attribution.

Emptiness follows the state: `designing` requires no phases and no lanes, other
states require at least one lane, and `shipped` requires at least one completed
outcome.

## Update contract

Keep these current whenever work starts, blocks, lands or verifies:

- `deliveryState` — move it when the build is authorized, and again when it lands.
- `updatedAt` and `updatedNote` describe the latest material change.
- `metrics` provide the headline programme counts.
- `phases` show dependency order and overall state.
- `focus.agents` lists currently active agents, their model and bounded responsibility.
- `lanes[].items` are the source of truth for major and minor outcomes.
- `commit` records the final integration SHA once an outcome lands.
- `evidence` records tests, typechecks, reviews or other completion proof.
- `ledger` is optional; the renderer derives it from lane items that have commits.

Do not mark an item complete merely because an agent branch contains a commit.
Mark it complete after integration and proportionate verification, and record the
integration SHA — not only the source-agent SHA.

`npm run validate` warns when the authored state contradicts the lanes: `shipped`
with nothing complete, `building` with everything complete, `designing` with
commit SHAs recorded. These warn rather than fail, because every one is a shape
the estate legitimately passes through while somebody is mid-edit.

## A replacement Final Review

Append a phase to the existing roadmap; never author a second file. Stamp each
phase with `sourceFinalReview` and each lane with the `phase` it belongs to, and
the roadmap page groups the programmes and keeps the earlier one visible above the
later.

Where a lane id appears in both programmes it is the same lane carried forward,
so the later version supersedes the earlier in place. Where the two share no lane
ids they concatenate — which is the case that matters, because it is the one where
taking either file alone would silently discard the other's delivery record.

## Project view

```text
/projects/<project>/roadmap
```

Derived at request time from the workspace roadmaps. There is no project-level
file to author or keep in step, and a workspace with no roadmap still appears, in
`designing`, from its manifest and round list alone.

## Agent ownership

Several agents can contribute to one roadmap, but appoint one integration owner
for the JSON file. Other agents should report status, evidence and SHAs to that
owner rather than editing the same file concurrently.
