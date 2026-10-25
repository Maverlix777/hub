# Owner outbox implementation and rollout boundary

This code adds durable owner messages to the existing Cloudflare Worker and existing D1 binding `HUB_DB`. It does not change `BOARD_GITHUB_TOKEN`, add credentials, create a second producer, or activate a timer. Production schema migration and deployment are not performed by this change.

## API

`GET /hub/api/outbox` requires an authenticated board owner. It returns `items`, `nextCursor` and `delivery: {status: "not_configured"}`. Pages contain at most 100 items; pass `before=<nextCursor>` to read the next page. A missing migration or storage failure returns HTTP 503 `outbox_unavailable`, not an empty list.

`POST /hub/api/outbox` requires the same owner session, exact canonical Origin, JSON, `X-Hub-Request: 1`, and same-origin Fetch Metadata when supplied. Existing Secure/HttpOnly/SameSite=Strict session cookies and response security headers remain intact. No cross-origin access is enabled. The payload is:

```json
{"idempotencyKey":"f23eccdf-29ca-4e76-bf60-04b79caf2000","kind":"answer","text":"Synthetic answer","target":{"sourcePath":"proposals/example/BOARD.md","taskId":"EX-1","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
```

Only `answer` and `message` are allowed. An answer requires a target. Messages may have a target or `null`. `revision` is the exact **source file blob SHA**, not the task ID and not a branch or commit SHA. The Worker freshly resolves a target against the board before first persistence. Changed source revision returns HTTP 409 `target_conflict`; clients keep the draft and require review of the refreshed task before resubmission. No automatic revision replacement is allowed. Existing same-key retries are resolved before source validation, so an already saved answer remains retrievable after source drift.

Text is plain data, 1–8000 characters, with disallowed control characters rejected. Rendering must use `textContent`. Unknown payload keys, unsafe paths, invalid task identifiers and revisions are rejected. Payload text never becomes a shell command or adapter name. The server binds messages to the session's user ID; there is no client-controlled owner field. Writes are limited to 20 per owner/IP per minute using the existing HMAC-backed limiter; missing limiter prerequisites fail closed.

Success returns HTTP 201 `{item}`. Exact duplicate requests return HTTP 200 `{item,duplicate:true}`. Reusing a key with different text, kind or target returns HTTP 409 `idempotency_conflict`. An atomic unique `(owner_id,idempotency_key)` constraint handles concurrent retries without a second message. Items are immutable after submission; subsequent answers get new keys. Reads are owner scoped.

## Receipt meaning

An accepted item has `status: "pending"` and `receipt: null`. This confirms **D1 persistence only**, not GitHub delivery. Error states are `error` and `conflict`. Only verified delivery can produce `synced` with `{url,commit,deliveredAt}`. Timestamps are integer UTC epoch milliseconds. Every item has a monotonic `version` for receipt compare-and-swap.

`applyDeliveryResult(db, result)` is a local operator module entry point, deliberately not an HTTP endpoint. It accepts only fixed error codes (`delivery_conflict`, `delivery_unavailable`, `delivery_uncertain`), or a GitHub commit-bound receipt for the approved private repository. Its SQL compares `expectedVersion` and refuses to downgrade a synced item. A failed CAS must be reconciled by reading the current item. The helper validates receipt shape; **the trusted delivery adapter must verify actual GitHub commit readback before calling it**. Shape validation alone is not delivery evidence.

## Unresolved operational dependency

The inspected existing `TELEMETRY-PUBLICATION.md` authorizes only one telemetry file through the existing GitHub connector. It expressly excludes direct Hub writes and new application delivery. Consequently this feature does not silently amend that authority or reuse its credential scope for owner messages.

Before production activation, a concrete authorized rollout must cover (1) applying `0002_owner_outbox.sql` to existing `hub-auth`, (2) deploying the reviewed SHA to `kolobovdjp-hub-next`, and (3) a narrowly approved existing-writer transport for reading owner outbox rows and importing verified receipts into that same D1 database, plus allowed GitHub task/inbox paths and agent adapters. No new HTTP machine credential, public queue, or worker GitHub write token is introduced here. The existing 15-minute heartbeat remains unchanged. Prepared code and synthetic tests do not establish scheduled or live delivery.

## Implementation self-check

- Scope is owner answer/message persistence and receipt CAS, not Claude unattended execution or another product.
- Reuses Worker owner authentication, Origin check, HMAC rate limiter and D1; no added package.
- Assumption: approved board sources provide authoritative `sourcePath`, `sourceRevision`, and task ID. An unavailable or changed target fails without overwriting an answer.
- Boundaries: browser→Worker input validation; Worker→D1 parameterized queries/unique constraints; local trusted adapter→D1 validated result/version CAS. GitHub readback belongs to the adapter and independent end-to-end evidence.
- Test commands and measured results are recorded in the integration report. Native SQLite tests cover storage, concurrency, reload, duplicate/conflict, rate limiting, privacy, receipt CAS and malformed input. Browser, live GitHub and production rollout are separate checks.
- End users see pending/error/conflict/synced, never an invented success. Production activation remains unverified until the rollout and transport dependencies are resolved.

### Observed local check

Command: `node --experimental-sqlite --test test/outbox.test.js test/board.test.js test/board-sources.test.js` (Node v24.22.1, Windows, native in-memory SQLite). Output:

```text
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Eleven are outbox-specific tests; the other fifteen exercise the ingested board and source boundaries. Synthetic plaintext fixtures only. This is not evidence of production migration, authenticated production UI, GitHub delivery, or a scheduled check.
