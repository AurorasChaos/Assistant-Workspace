# Authoring reviews

Create a kebab-case workspace directory and add `workspace.json`:

```json
{
  "schemaVersion": 1,
  "id": "billing-workspace",
  "title": "Billing workspace",
  "summary": "Review rounds for the billing redesign.",
  "order": 10
}
```

When the server uses `REVIEW_PROJECTS_ROOT`, create the workspace under the relevant project with `npm run workspace:create -- <project-id> <workspace-id> [title]`. The review schema inside the workspace is unchanged.

Create a round directory with `review.json` and `mocks/`. Use the fictional example as the full schema reference. Important fields are:

- `id`, matching the directory name;
- `order`, controlling round order;
- `mocks`, each with `id`, `title`, `description` and an HTML `file`;
- `questions`, each with two or more options plus optional recommendation;
- `handoff`, explicitly describing what completion does and does not authorize.

`workspace.json` may name the people who review it:

```json
{ "reviewers": ["someone@example.com"] }
```

A host can use that list to decide who may open the workspace. It is optional and
purely authored data; the engine itself does not enforce access.

Run `npm run validate` after editing. Restarting the server is not required for new content because discovery happens per request.

For private material, keep the content outside this repository:

```bash
REVIEW_CONTENT_ROOT=/srv/review-content \
REVIEW_DATA_ROOT=/srv/review-state \
npm start
```

An agent can publish a new round atomically by writing it to a temporary directory, validating it, then renaming the directory into the workspace.

Every workspace ends with `final-review/`. Follow the [Final Review rule](final-review.md); validation compares its `sourceReviews` against the mock and question coverage recorded in the final manifest.
