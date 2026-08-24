# Concepts

## Workspace

A workspace groups one design effort and its history. It has a `workspace.json` and contains ordered review directories. Examples are a product area, a discovery project or a feature redesign.

## Review round

A review round is an immutable authored proposal plus mutable reviewer state. Its `review.json` defines the screens, questions, recommendations and handoff wording. Its `mocks/` directory contains the connected HTML prototype.

## Authored content versus reviewer state

Authored content can be versioned and shared. Reviewer state may contain private comments and is written under `.review-data` (or `REVIEW_DATA_ROOT`). This boundary lets a public engine serve private review packs without copying them into the engine repository.

## Completion versus implementation

Completion says the reviewer has finished this decision artifact. It does not mean a product build should start. The compiled handoff repeats that gate so downstream agents cannot silently reinterpret the status.

