# Hosted deployment

Use one service and path-based routing:

```text
https://example.test/reviews/
https://example.test/reviews/groups/billing-workspace/
https://example.test/reviews/groups/billing-workspace/reviews/round-3/
```

Every link the server emits is relative, and the browser derives its base from
`location.pathname`, so a proxy that strips the prefix (Caddy's `handle_path`,
nginx's trailing-slash `proxy_pass`) needs no engine configuration. The static
fallback on the header brand link is relative too, so it survives a prefix even
before JavaScript runs.

For Microsoft Entra ID, put an Entra-aware proxy in front of the Node service, following the same operational pattern as the host's existing protected pages. Keep identity and group authorization at the proxy or add verified identity headers with a strict trusted-proxy configuration.

## Hosted configuration

All of it is off by default, so a workstation keeps today's behaviour exactly.

| Variable | Effect |
|---|---|
| `REVIEW_TRUSTED_PROXY=1` | Trust `X-Review-User`, `X-Review-Display` and `X-Review-Capabilities` from the proxy. Set this ONLY when the engine is bound to localhost behind an authenticating proxy. |
| `REVIEW_INDEX_TTL_MS` | Cache discovery for this many milliseconds. Unset (the default) re-reads the directory on every request, which is what a workstation wants. |
| `REVIEW_STATE_ROOT` | Keep reviewer state under this directory (`<root>/<project>/…`) instead of beside the content. Lets a shared content repository stay free of host-specific paths. |
| `REVIEW_INVALIDATE_SECRET` | Enables `POST /internal/invalidate` (localhost only) so the publisher can announce a change instead of the server inferring one. |

Capabilities are enforced on write, as four separate questions:

| Capability | May |
|---|---|
| `read` | open the review |
| `annotate` | add annotations |
| `decide` | record an answer |
| `complete` | declare the round settled |

`decide` and `complete` are deliberately distinct: recording a decision and
closing a round are different acts.

## Agents

Set `X-Review-Subject-Kind: agent` (optionally `X-Review-Agent-Model`) and the
engine treats the caller as a machine:

- `complete` is stripped from its capabilities, whatever the proxy sent;
- every answer it writes is stored as `status: "proposed"`, carrying who proposed
  it and when — it does not count as decided;
- it never becomes the review's `reviewer`;
- a round with an outstanding proposal refuses to close, with 409 and the list of
  questions still awaiting a person.

### Recording a proposal

`POST …/reviews/<round>/api/propose` takes one answer and nothing else:

```json
{ "questionId": "seed-trigger", "selected": "first-discovery",
  "reasoning": "…", "baseVersion": 4 }
```

It needs `decide`, refuses an unknown question or option, and refuses a stale
`baseVersion` rather than merging it away. The full `api/review` endpoint stays
the browser's: it rewrites the compiled Markdown handoff, which is a human-facing
artifact an agent has no business regenerating to record one proposal.

A person confirming a proposal moves it to `decided` and records them as the
confirmer, keeping the proposal visible. Answers written before any of this
existed have no authorship and read as human decisions, which is what they were. Identity, when
present, is stamped on the review and on each annotation.

## Endpoints a host uses

- `GET /api/index.json` — projects, workspaces, rounds, decision and annotation counts. Feeds an index page in your own application.
- `GET /api/events` — server-sent events; `content-changed` on publish, `state-changed` on a save.
- `POST /internal/invalidate` — drop the cached index. Localhost plus `X-Review-Invalidate-Secret`; 404s otherwise.

## Prototype isolation

Mock documents are agent-authored code. The review shell loads them in a
sandboxed iframe (`allow-scripts allow-forms allow-modals`, never
`allow-same-origin`), which puts each prototype on an opaque origin: no cookies,
no storage, no access to the page embedding it.

Because the shell can no longer reach into the frame, annotation runs over
`postMessage`. The server injects a small bridge into every mock document it
serves, so existing prototypes keep working unchanged:

- shell → mock: `assistant-workspace:annotation-mode`
- mock → shell: `assistant-workspace:annotate-target`

The shell identifies the frame by `event.source`, not by origin string — a
sandboxed document reports `event.origin` as `"null"`. Note that inside such a
frame `location.origin` still resolves to the real URL origin; it is
`window.origin` that becomes `"null"`.

Add a response CSP on mock paths for defence in depth, so the isolation holds
even when a prototype is opened directly rather than through the shell.

Recommended hosted components:

- read-only content mount for published rounds;
- separate writable state volume;
- staged upload area;
- validator and atomic publisher;
- audit log and backups;
- size/type limits and archive traversal protection;
- optional secondary sandboxed origin for untrusted HTML.

The local server is not itself a production authentication boundary.

## Persistent local user service

The repository includes `systemd/assistant-workspace.service` for a single workstation daemon. Install it as a user service, then enable it:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/assistant-workspace.service ~/.config/systemd/user/assistant-workspace.service
systemctl --user daemon-reload
systemctl --user enable --now assistant-workspace.service
```

The unit binds only to `127.0.0.1:8777` and discovers projects from `~/.local/share/assistant-workspace/projects` on every request. New valid project manifests and workspaces therefore appear without a restart.
