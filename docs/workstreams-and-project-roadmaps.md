# Follow-up: workstreams and one roadmap per project

**Status:** captured, not designed. Raised 24 August 2026 while the hosted
Assistant Workspace build was in flight. Deliberately not folded into that work.

## The problem

The hierarchy is three levels — project → workspace → review round — and a
workspace ends in a single Final Review. That models one piece of work well and
has no answer for the second: when a colleague raises a question about a
workspace that has already shipped, the options today are to add a round 4 to a
closed sequence (mixing new decisions into accepted history) or to create a
parallel workspace (losing the connection to the work it follows up on).

Neither survives more than one follow-up.

## The shape agreed in discussion

Add a **workstream** (review series) layer inside a workspace:

```text
Atlas
  Billing workspace
    Initial implementation      → rounds 1–3, Final Review
    Follow-up: <colleague question>  → its own rounds, its own Final Review
    Follow-up: <another issue>       → its own rounds, its own Final Review
```

Each workstream owns its rounds, decisions and Final Review, so a follow-up
never edits accepted history and never has its decisions mixed with another
stream's. Unlimited follow-ups per workspace.

## One roadmap per project, replacing per-workstream roadmaps

Today each workspace's Final Review carries its own implementation roadmap.
That does not scale to follow-ups and it fragments the answer to "where is this
project up to".

Instead: **one durable, independently shareable roadmap per project**, for the
project's whole lifetime.

- The initial build and every later follow-up are *streams on that one roadmap*,
  each linking to its own rounds, decisions, specification, delivery status and
  commit SHAs.
- A follow-up updates the project roadmap's history and current focus. It does
  not create another roadmap.
- Stable URL, so it can be shared once and stay correct.
- It replaces workstream roadmaps rather than sitting above them.

## Requirements to carry into the design round

1. **Backward compatibility.** Existing content has no workstream level.
   Manifests without one must keep working and keep their URLs; the obvious
   route is an implicit default workstream per workspace.
2. **New projects get it by default.** `project:create` and `workspace:create`
   should scaffold the workstream layer and the project roadmap, so this is the
   normal shape rather than something assembled by hand each time.
3. **Backdating.** After the hosted move, the project roadmap must be
   backfilled with a workspace's existing history — the roadmap has to accept
   work that completed before the roadmap existed.
4. **Validation.** `npm run validate` must understand the new level, and the
   Final Review coverage rule must apply per workstream rather than per
   workspace.
5. **URLs.** Decide the canonical form
   (`/projects/<p>/groups/<w>/streams/<s>/reviews/<r>/`?) and what redirects or
   uniqueness rules keep older links alive.

## Interaction with the hosted build

The hosted Assistant Workspace Final Review (accepted 24 August 2026) includes a
per-workspace `implementation-roadmap` artifact. A per-project roadmap supersedes
that placement. This is additive rather than contradictory — none of the hosting
decisions depend on where the roadmap lives — and should be recorded as a
correction on the project roadmap once it exists.

## Sequencing

1. Finish and move over the hosted Assistant Workspace build.
2. Design this in the workspace itself: it changes the data model, the URL
   scheme, the validator and the scaffolding, so it is material design work and
   belongs in a review round, not a quiet refactor.
3. Use the first follow-up series for the question that prompted this, once that
   question has been captured. Only the discussion about where follow-ups should
   live has been recorded so far.
