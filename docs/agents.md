# Agent workflow

Assistant Workspace is structured so several agents can author rounds without overwriting one another.

The durable hierarchy is project → workspace → review round. Do not create folders named after temporary agents. A project such as Atlas can contain `billing-workspace`, while several agents own disjoint rounds or artifacts inside it. See [Project namespaces](projects.md).

## Recommended lanes

- One agent owns the workspace manifest and integration review.
- Each prototype agent owns one round directory or a clearly isolated mock subset.
- A question/spec agent owns decision wording and verifies recommendations against the mockups.
- A validation agent exercises all controls and checks the compiled handoff.

The integration owner runs `npm test`, reviews private-data boundaries and publishes a complete round atomically. Agents should not edit generated `.review-data` files as authored content.

## Live updates

The current server discovers folders on every request, so a safely renamed round becomes visible immediately. A hosted upload API should add staging, validation, locks/version checks and an audit trail before it makes uploaded folders live.

## Final specification

When the last numbered round is accepted, compile the product specification and publish a required Final Review containing all accepted mockups, all sourced decisions and that specification. List parallel implementation lanes, file ownership, contracts and integration order. Only after Final Review is accepted should the agent ask separately whether the product build should begin.
