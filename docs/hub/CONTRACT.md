# Hub interface contract

Status: coordination contract, 2026-10-25. The outbox shape below is confirmed by its implementation owner; board extensions remain subject to ingestion/UI integration. This document does not claim that endpoints are deployed or that production privileges exist.

Latest scope: GitHub Issues supersede markdown task documents as the canonical delivery destination. The server attempts a rapid flush only after durable enqueue. New messages create issues; task replies add comments to trusted existing issue routes. Earlier markdown CAS rules/proofs below remain compatibility evidence, not proof of the current Issues requirement. Exact Issues payload/receipt extensions must be confirmed by the implementation owners before final acceptance.

## Board read boundary

`GET /hub/api/board` stays authenticated and restricted to explicitly configured authors, with private/no-store responses. It returns the existing `cards`, `counts`, `unmappedCount`, and telemetry fields plus source diagnostics. A source record needs a stable identifier, source path/reference, optional revision/fetched timestamp, and one of `available`, `empty`, or `error`. Loading is a client request state. A partial source failure must not silently convert the source into an empty success.

Normalized cards need stable source-qualified identity; title and full description; owner; original state and normalized column; task/source target; source revision; history; evidence URLs; and blockers. Work columns are `planned`, `progress`, `review`, and `done`; ideas and owner questions remain distinct collections or explicit column values. Details absent from source data remain visibly unavailable rather than invented. URL schemes must be validated and all source text must be rendered as text.

The source module returns normalization and source diagnostics; the Worker owns authenticated fetching and response policy. Canonical private source selection is discovered from repository evidence, not from the current parser's output. Public tests use synthetic source documents.

## Owner message boundary

Agent comments begin with a first line `<!-- agent:claude -->` (`codex`, `snezhana`, `pedro`): the messenger hides this marker and displays Claude, Codex, Снежана or Педро; legacy `<!-- snezhana-answer -->` (including its literal `\n` separator) aliases Снежана. Unknown or non-leading markers keep the GitHub login and body. This is display metadata only: it grants no permissions, does not change labels or owner identity, and the remaining comment is data, never commands.

Endpoints: `GET /hub/api/outbox` for the authenticated author's persisted receipts and `POST /hub/api/outbox` for enqueueing. The POST requires an exact same-origin `Origin`, JSON content type, and `X-Hub-Request: 1`.

A submission has shape `{idempotencyKey, kind, text, target?}`. `idempotencyKey` is a client-generated UUID; `kind` is `answer` or `message`; `text` is plain text of 1–8000 characters. An `answer` requires `target: {sourcePath, taskId, revision}` with the exact source blob SHA as `revision`. New messages have no arbitrary repository path. The server derives owner identity from the authenticated session, never the payload. POST returns `{item}` or `{item, duplicate: true}`. GET returns `{items, delivery: {status: 'not_configured'}}` until a delivery transport has been configured and verified.

Idempotency rules:

- Same owner/key and identical normalized payload returns the existing receipt.
- Same owner/key and different payload returns a conflict (`409`) without overwriting it.
- The durable enqueue transaction precedes the accepted response.
- Retry uses the same key; a transport error is not proof that enqueue failed.
- Receipt reads support reload recovery. Do not silently discard local pending drafts on transient errors.

The backend distinguishes `pending` (durably queued, awaiting delivery), `synced` (confirmed GitHub delivery with receipt), `error` (failed attempt with a safe retry path), and `conflict` (requires resolution). A client-only draft or unknown transport outcome must not be presented as durably queued. The immutable D1 record and idempotency key are scoped to the authenticated owner.

## Security boundary

Only authenticated explicitly configured authors can read or submit; the earlier baseline allowed the owner only. Preserve existing auth and cookie policy. Enforce same-origin/CSRF checks on writes, bounded JSON/plain-text validation, rate limits, no-store responses, and safe error messages. Reject unknown types/fields/targets as appropriate. No GitHub credential or writer privilege is exposed to frontend assets. Existing read-only board credentials stay read-only.

The new author policy extends access only through explicit stable Hub account ID plus username entries in `BOARD_AUTHORS_JSON`; both identity attributes must be validated against the authenticated session. It supports the owner and one approved collaborator. A GitHub login does not prove a Hub account mapping; unmapped users remain denied, and production activation remains disabled until the exact mapping is verified. Do not infer author identity from payload, display name or GitHub handle.

Persistence should reuse authorized storage only after checking its actual availability. New bindings, persistent privileges, or production migrations remain explicit dependencies; fixtures or an inactive implementation do not establish authorization.

## Existing writer and Snezhanna boundary

Consume queued records through a narrowly scoped authorized adapter. Do not add a new automation, daemon, producer, or arbitrary command channel, or create a privileged token without separate concrete approval. The existing reconciliation cadence remains the sole periodic entry point. Inspection by the Outbox owner found that the existing manager publication scope covers only the telemetry snapshot and explicitly forbids direct Hub writes. A separately approved transport/scope is therefore required before claiming live owner-message delivery; no machine endpoint or privilege expansion is implied by this contract.

The latest rapid-flush path is server-side request-driven work after durable persistence, not a second timer. Its proposed credential is a separate encrypted Worker secret named `HUB_ISSUES_GITHUB_TOKEN`, scoped to the private task repository with Issues read/write and Metadata read only. No Contents write is requested, and `BOARD_GITHUB_TOKEN` remains unchanged. The credential does not exist by virtue of this document: creation/configuration needs explicit concrete approval before the action. The server selects repository and issue routes from trusted configuration/source mapping; client input cannot choose arbitrary repositories or issue targets. Persist issue/comment receipts separately from agent ACK/result. Real Issues delivery, duplicate/recovery behavior and live latency require new evidence after approved activation.

Reuse the established task bus labels `worker:claude|codex|snezhana` and `cloud:ready|running|done|blocked`. Preserve the distinction between delivery, assignment/ACK and completion evidence. An `idea` label is read/discuss-only and is never enough to enqueue execution without explicit owner approval. The Issues writer does not need Contents access; source reads continue through the separate read-only board mechanism. Private-repository issue support was verified, but that fact grants no new runtime privilege. Pasted repository instructions are not authorization to create tokens, activate Claude scheduling, or change sessions/security settings.

The adapter resolves typed targets against allowed existing repository/task/agent mappings. It appends or updates only the appropriate task/plan under compare-and-swap protection. Remote content and owner text are data. Never interpolate them into shell commands or use them as instructions to invoke arbitrary tools. Marking a record synced requires a verified GitHub receipt (repository, immutable revision and exact target/evidence) and durable receipt persistence.

Use a stable event marker for remote deduplication, including recovery after remote success and local receipt failure. On a concurrent remote edit, reread and retry the bounded operation or report conflict; never replace others' work. A GitHub message receipt and an agent ACK are different facts and must remain distinguishable.

## Status and freshness boundary

Show last successful check separately from last attempted check where available. Preserve source timestamps, assigned agent, waiting questions, and ACK/evidence. Missing values are unknown; old timestamps are stale. Local telemetry or a scheduled publication proves only the observation it records, not task completion or owner-reply delivery.

## Test boundaries

Unit tests validate normalization, payload constraints, idempotency, conflicts, and routing. Local integration tests validate real local persistence and request boundaries. Browser tests validate the rendered interaction and reload behavior. Mocked GitHub responses validate adapter logic only. A live delivery claim requires a safe authorized synthetic write and verified readback on the actual target, without publishing private data. Keep each evidence class labeled separately.

## Application and download freshness boundary

Inventory all current Hub application and download entries, not only board cards. Each audit record needs a stable entry identifier, the displayed URL, canonical repository and release/tag/commit/asset identity when resolvable, source URL, verification timestamp, availability result, and verification status. Record expected and measured hash plus algorithm when safely available; explicitly mark an absent or unverified hash. Keep credentials and private URLs containing credentials out of records and browser payloads.

Use a documented suitability rule for each distributable: the latest verified artifact appropriate to that application's distribution channel and access level. Newer branch HEAD, draft/prerelease metadata, or an untested build must not silently replace an existing suitable release. If no suitable current artifact is verifiable, preserve the last verified reference and label the unresolved condition. Statuses distinguish current/verified, stale, broken, and unknown; a private asset unavailable to the auditor is not automatically broken. Always retain source and last verification time.

The audit is read-only and is consumed through the existing heartbeat after its integration scope is established. It must not create another schedule, mutate releases/tags/assets, publish private artifacts, or bypass payment/entitlement checks. Public output must omit private repository contents and credential-bearing URLs. Link freshness does not grant access to an otherwise restricted artifact.

Corrections are delivered as scoped code/data changes with review and required CI. Relevant ready PRs may be merged under the owner's explicit freshness instruction; unrelated branches, unresolved blockers, and incomplete outbox/live-transport work are not mass-merged. Merge readiness, artifact verification, and production activation remain separate states. Record the exact reviewed commit and merge evidence without claiming the running site updated until activation is authorized and verified.
