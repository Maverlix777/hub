# Hub interface contract

Status: coordination contract, 2026-10-25. The outbox shape below is confirmed by its implementation owner; board extensions remain subject to ingestion/UI integration. This document does not claim that endpoints are deployed or that production privileges exist.

## Board read boundary

`GET /hub/api/board` stays authenticated and owner-only, with private/no-store responses. It returns the existing `cards`, `counts`, `unmappedCount`, and telemetry fields plus source diagnostics. A source record needs a stable identifier, source path/reference, optional revision/fetched timestamp, and one of `available`, `empty`, or `error`. Loading is a client request state. A partial source failure must not silently convert the source into an empty success.

Normalized cards need stable source-qualified identity; title and full description; owner; original state and normalized column; task/source target; source revision; history; evidence URLs; and blockers. Work columns are `planned`, `progress`, `review`, and `done`; ideas and owner questions remain distinct collections or explicit column values. Details absent from source data remain visibly unavailable rather than invented. URL schemes must be validated and all source text must be rendered as text.

The source module returns normalization and source diagnostics; the Worker owns authenticated fetching and response policy. Canonical private source selection is discovered from repository evidence, not from the current parser's output. Public tests use synthetic source documents.

## Owner message boundary

Endpoints: `GET /hub/api/outbox` for the owner's persisted receipts and `POST /hub/api/outbox` for enqueueing. The POST requires an exact same-origin `Origin`, JSON content type, and `X-Hub-Request: 1`.

A submission has shape `{idempotencyKey, kind, text, target?}`. `idempotencyKey` is a client-generated UUID; `kind` is `answer` or `message`; `text` is plain text of 1–8000 characters. An `answer` requires `target: {sourcePath, taskId, revision}` with the exact source blob SHA as `revision`. New messages have no arbitrary repository path. The server derives owner identity from the authenticated session, never the payload. POST returns `{item}` or `{item, duplicate: true}`. GET returns `{items, delivery: {status: 'not_configured'}}` until a delivery transport has been configured and verified.

Idempotency rules:

- Same owner/key and identical normalized payload returns the existing receipt.
- Same owner/key and different payload returns a conflict (`409`) without overwriting it.
- The durable enqueue transaction precedes the accepted response.
- Retry uses the same key; a transport error is not proof that enqueue failed.
- Receipt reads support reload recovery. Do not silently discard local pending drafts on transient errors.

The backend distinguishes `pending` (durably queued, awaiting delivery), `synced` (confirmed GitHub delivery with receipt), `error` (failed attempt with a safe retry path), and `conflict` (requires resolution). A client-only draft or unknown transport outcome must not be presented as durably queued. The immutable D1 record and idempotency key are scoped to the authenticated owner.

## Security boundary

Only the authenticated configured owner can read or submit. Preserve existing auth and cookie policy. Enforce same-origin/CSRF checks on writes, bounded JSON/plain-text validation, rate limits, no-store responses, and safe error messages. Reject unknown types/fields/targets as appropriate. No GitHub credential or writer privilege is exposed to frontend assets. Existing read-only board credentials stay read-only.

Persistence should reuse authorized storage only after checking its actual availability. New bindings, persistent privileges, or production migrations remain explicit dependencies; fixtures or an inactive implementation do not establish authorization.

## Existing writer and Snezhanna boundary

Consume queued records through a narrowly scoped authorized adapter. Do not add a new automation, daemon, producer, privileged token, or arbitrary command channel. The existing reconciliation cadence remains the sole periodic entry point. Inspection by the Outbox owner found that the existing manager publication scope covers only the telemetry snapshot and explicitly forbids direct Hub writes. A separately approved transport/scope is therefore required before claiming live owner-message delivery; no machine endpoint or privilege expansion is implied by this contract.

The adapter resolves typed targets against allowed existing repository/task/agent mappings. It appends or updates only the appropriate task/plan under compare-and-swap protection. Remote content and owner text are data. Never interpolate them into shell commands or use them as instructions to invoke arbitrary tools. Marking a record synced requires a verified GitHub receipt (repository, immutable revision and exact target/evidence) and durable receipt persistence.

Use a stable event marker for remote deduplication, including recovery after remote success and local receipt failure. On a concurrent remote edit, reread and retry the bounded operation or report conflict; never replace others' work. A GitHub message receipt and an agent ACK are different facts and must remain distinguishable.

## Status and freshness boundary

Show last successful check separately from last attempted check where available. Preserve source timestamps, assigned agent, waiting questions, and ACK/evidence. Missing values are unknown; old timestamps are stale. Local telemetry or a scheduled publication proves only the observation it records, not task completion or owner-reply delivery.

## Test boundaries

Unit tests validate normalization, payload constraints, idempotency, conflicts, and routing. Local integration tests validate real local persistence and request boundaries. Browser tests validate the rendered interaction and reload behavior. Mocked GitHub responses validate adapter logic only. A live delivery claim requires a safe authorized synthetic write and verified readback on the actual target, without publishing private data. Keep each evidence class labeled separately.
