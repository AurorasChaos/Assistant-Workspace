# Roadmap and useful additions

The highest-value next additions are:

1. Configurable base path for clean `/reviews/` hosting behind an existing site.
2. Authenticated staging/upload API with schema validation and atomic publish.
3. Content version hashes so answers stay pinned to the exact prototype reviewed.
4. Review diff: decisions, annotations and mock assets changed between rounds.
5. Search, tags, owners and status across workspaces.
6. Side-by-side design variants and per-variant voting.
7. Threaded comments, mentions and reviewer sign-off matrix.
8. Live reload or server-sent events when agents publish a round.
9. Optimistic concurrency or locks for multiple reviewers.
10. JSON, Markdown and PDF exports plus webhook notifications.
11. Workspace/round generator CLI and reusable question templates.
12. Accessibility checks and automated interaction smoke tests.

A larger structural change is captured separately in
[Workstreams and project roadmaps](workstreams-and-project-roadmaps.md): a review-series
layer inside each workspace so a workspace can carry unlimited follow-ups, and one durable
shareable roadmap per project replacing the per-workstream roadmaps.

For public collaboration, add issue templates, a code of conduct, changelog, semantic releases and a selected open-source licence after ownership is decided.

