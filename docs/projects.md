# Project namespaces

One Assistant Workspace server can host every local project without assigning ports or content roots to individual agents.

## Layout

`REVIEW_PROJECTS_ROOT` contains one directory per durable project:

```text
projects/
  atlas/
    project.json
  beacon/
    project.json
    reviews/
      field-operations/
        workspace.json
  harbour/
    project.json
```

A project manifest may keep content and generated state beside itself:

```json
{
  "schemaVersion": 1,
  "id": "beacon",
  "title": "Beacon",
  "summary": "Beacon review workspaces.",
  "contentRoot": "reviews",
  "stateRoot": "state"
}
```

It may instead reference an existing absolute content or state directory. This lets the single service expose private project material without copying it into the public engine repository.

## URLs

```text
/projects/atlas/groups/billing-workspace/
/projects/atlas/groups/billing-workspace/reviews/final-review/
```

Legacy `/groups/<workspace>/` URLs continue to work only while the workspace id is unique across all projects. New links should always include the project.

## Agent collaboration

Projects own workspaces; agents do not. Several agents can work on one workspace by owning disjoint rounds or artifacts. A workspace should describe one durable piece of work, such as `billing-workspace`, rather than one agent session.

Use the scaffold commands documented in the README, then validate the entire configured project root before publishing a round.
