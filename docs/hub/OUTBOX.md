# Dashboard authors, durable outbox and canonical Issues delivery

## Current contract

GitHub Issues are the canonical destination for new dashboard messages. New messages create issues with the existing `idea` label; answers append comments to existing issues selected by trusted server configuration. Neither submission nor GitHub delivery authorizes execution or changes agent permissions. Agent ACK and result remain unknown without real evidence. The old Markdown adapter is historical test evidence, not the production destination.

The Worker reuses HUB_DB, existing passkey sessions, CSRF protection and HMAC rate limiting. Prepared migrations 0002_owner_outbox.sql and 0003_owner_issues.sql have only been applied to local test databases. No production schema, secret, ACL, scheduler or deployment has changed.

## Author authorization

Optional server configuration BOARD_AUTHORS_JSON is an array of at most two objects with exactly {hubUserId,hubUsername,githubLogin}. It binds a GitHub identity to an existing stable Hub user ID and exact normalized username. Username registration alone cannot acquire permission. Duplicate identities, malformed configuration and mismatched IDs fail closed.

When this explicit mapping exists it is authoritative: stale BOARD_OWNER_USERNAME names cannot gain access. Only when mapping is absent does the existing owner allowlist retain prior behavior, with githubLogin:null honestly indicating no GitHub attribution mapping. The colleague's real Hub account mapping is unknown and is not guessed or activated.

Every new item stores an immutable server-derived author snapshot. Clients cannot supply it. Administrator mapping changes cannot rewrite previous attribution. Each author reads only their own submissions; both configured authors can view the shared board.

## Browser API

GET /hub/api/outbox returns {items,nextCursor,delivery}. Pages contain at most 100 records; use ?before=<nextCursor> for older records. Items contain author, status, version, receipt, error, timestamps, agentAck:null and agentResult:null. Missing schema or failed storage returns503 outbox_unavailable, never an empty queue.

POST /hub/api/outbox requires authorized session, exact canonical Origin, JSON, X-Hub-Request:1 and same-origin Fetch Metadata when supplied. Input is {idempotencyKey,kind,text,target}. The key is a UUID reused on retry. Kind is message or answer. Text is plain data, 1–8000 characters with prohibited controls rejected; render with textContent. A message omits target or uses null. An answer supplies {sourcePath,taskId,revision}: safe relative Markdown source path, uppercase task ID ending with a hyphen and digits, and exact40-hex source blob SHA. This displayed source identity maps through trusted HUB_ISSUES_TASK_ROUTES to a canonical issue. The client cannot choose an issue number, repository, adapter or executor.

Before first persistence the Worker checks source/task and revision. A stale source yields409 target_conflict; retain the draft for review. Existing exact retries succeed even after source drift. A unique (owner_id,idempotency_key) constraint handles concurrent requests. Changed content with the same key returns409 idempotency_conflict and never overwrites. Writes and retries share the existing author/IP limit of20 per minute.

HTTP201 {item} means saved/pending, not GitHub delivery. Exact duplicates return200 {item,duplicate:true}. GitHub delivery is status:synced with receipt {kind:'issue'|'comment',url,issueNumber,commentId,deliveredAt}. The receipt URL matches the approved repository and exact issue/comment identity. GitHub delivery is not agent ACK or result.

## Separate server Issues capability

Fast delivery requires HUB_ISSUES_ENABLED==='true' and separate server secret HUB_ISSUES_GITHUB_TOKEN. BOARD_GITHUB_TOKEN remains read-only and untouched. The proposed credential needs an explicit grant for Issues read/write and Metadata read on the single private Maverlix777/agent-handoffs repository, without Contents write or other repositories. No secret value is exposed to the frontend or repository.

After durable enqueue, ctx.waitUntil calls flushIssueDelivery from src/issues-delivery.js. An exact duplicate pending/error submission can trigger safe reconciliation. No new timer is created; existing Claude/Doctor/Snezhanna sessions remain unchanged. GET reports delivery.status:enabled only with the flag and separate token; otherwise not_configured. Saved messages remain visible while delivery is disabled.

## Lease and uncertain outcomes

claimDelivery atomically admits one attempt. beginDeliveryAttempt persists a closed bounded intent before any non-idempotent POST. Stale attempts cannot begin or finish after takeover. Expired attempts with an intent are reconciliation-only: timeout, lease expiry, crash or a negative search never authorizes another POST.

finishDelivery accepts an exact typed receipt after transport readback, checking lease identity, intent kind and comment issue identity. It never downgrades synced items. Preflight failure before intent is retryable. Failure after intent retains uncertainty for reconciliation. Receipt updates increment version. Legacy local applyDeliveryResult cannot race an active Issues lease and is not exposed over HTTP.

## Verification and remaining dependency

Observed command: node --experimental-sqlite --test test/outbox.test.js test/issues-delivery.test.js

Result:35 tests,35 pass,0 fail,0 skipped. Covers explicit two-author access, false mappings, stale legacy allowlist denial, immutable attribution, CSRF, isolation, duplicate/conflict, atomic claims, uncertain reconciliation, receipt identity, and actual Worker→native SQLite→mock GitHub transport through ctx.waitUntil. Verifies exactly one POST after durable intent, reload receipt and ACK/result remaining null. All fixtures/identities are synthetic.

This is not live GitHub transport, authenticated production UI, credential provisioning, schema rollout or scheduled-delivery proof. Activation still needs the separately approved scoped secret, verified colleague Hub identity mapping, trusted task→issue routes, and reviewed migration/deployment to kolobovdjp-hub-next. The existing telemetry heartbeat's narrow grant is not reused for these capabilities.

Self-check: handles the requested Hub author/message boundary, reuses existing primitives, preserves author/content, fails closed on absent dependencies, treats text as data, and separates persistence, GitHub delivery, ACK and result. No execution follows automatically from idea labels. Listed tests were run; live delivery and rollout remain unverified.
