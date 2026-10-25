# Hub interactive board UI

## Implemented

Light responsive board with separate planned/progress/review/done columns, prominent owner questions and source-aware ideas. Cards are native buttons. Large native dialog includes source revision, context, owner, status, history, evidence and blockers. Escape and browser Back close it, Tab remains inside, focus returns to the card. At 390px the dialog fills the viewport and columns stack.

Owner answer and message forms call the real `/hub/api/outbox` contract using same-origin credentials, JSON and `X-Hub-Request: 1`. A generated UUID stays unchanged while an uncertain request is retried. Definitive source conflicts require reopening the newly fetched context; the text is retained. Pending means server persistence only; synced requires a backend receipt. Pagination reads older persisted messages. The UI does not pretend the writer is connected when delivery is `not_configured`.

Source errors/unsupported formats differ from empty data. Freshness, unavailable last Hub check, absent executor identity and producer verification claims remain explicit. Refresh reads the API on demand and once per minute while visible; it neither starts a producer nor alters the existing Snezhanna heartbeat.

## Privacy and drafts

No secrets, private fixtures, `localStorage` or `sessionStorage`. Draft text stays only in current-tab memory, including modal close/reopen. Navigation warns about an unsaved/uncertain draft. A full reload loses an unaccepted draft; accepted records reload from the owner-authenticated server queue. This is deliberate: a later signed-in user cannot inherit a browser-persisted private draft. Rejected requests do not claim persistence. 401/403 clears rendered private records and drafts. Text is rendered as text, links require HTTPS and cannot contain URL credentials.

## Validation

- `node --check public/apps/board.js`: exit 0.
- `node tests/check-csp.cjs`: `5 из 5 страниц и 5 скриптов ок`.
- `node --test test/telemetry-ui.test.js`: tests 1, pass 1, fail 0. The expanded DOM model retains producer-claim/manual-board separation checks; Russian labels replace earlier English `unknown`/`result_reported` output.
- `node tests/board-ui-contract.cjs` with existing Playwright and Edge: `PASS: modal/focus/Escape/back, literal XSS, same-key retry, receipt reload, 390px layout; synthetic API only.`
- The first sandbox Edge launch failed; local browser execution with approved escalation succeeded. The test closes its own browser and HTTP server. No user browser session is changed.

The UI contract test uses synthetic API responses. It is not evidence of Worker database persistence, real GitHub delivery or authenticated production UI. Independent QA owns actual Worker/SQLite browser integration and screenshots.

## Self-check

- Solved assigned UI surface only; backend policy stays in the Worker.
- Reused plain DOM, native dialog and existing CSS conventions; no framework/dependency added.
- Assumes API schema documented by outbox/ingestion owners; tests assert exact request header and identical retry key.
- Empty, missing, stale, duplicate/retry, source-conflict revision and unsafe URL/text boundaries handled. Concurrent submits are disabled while in flight.
- Page-to-Worker is authenticated fetch; source data enters text-only DOM; receipt links pass HTTPS validation.
- Checks above passed with their stated scope. No live production or GitHub delivery claim.
- User sees readable state labels and exact server receipt IDs. Missing evidence is never presented as completion.

## Review fixes

The auth-loss review found that concurrent successful responses could arrive after another request returned 401/403. Added a terminal per-page invalidation generation checked around fetch/JSON and before consumers render. Invalidation clears telemetry, closed-modal contents, drafts and search, and disables forms/refresh permanently until a new authenticated page load. Finally blocks cannot re-enable them. Real Edge synthetic regression covers delayed board GET, outbox GET and POST successes after concurrent 403; all three reject private content resurrection.

Independent visual QA found retained modal scroll position after reopening. Opening a card now resets dialog/content scroll to zero after focus. The 390px browser regression scrolls down, closes/reopens and asserts title visibility and zero scroll.

## GitHub Issues and authorized authors (supersedes document-receipt UI)

The backend contract now includes an immutable server-derived author snapshot: `hubUserId`, `hubUsername`, and optional mapped `githubLogin`. The UI displays that snapshot and never guesses a person's account or assigns access. Backend authorization and per-author queue isolation remain outside the UI. Two synthetic author-session tests verify attribution rendering only; they do not establish the real collaborator account mapping or ACLs.

Each message shows four separate stages: SAVED (server persistence), DELIVERED (verified GitHub Issues delivery), ACK (executor acknowledgment), RESULT (execution evidence). Only `synced` plus an exact issue/comment receipt is shown as Issues delivered. Receipt links must match `https://github.com/Maverlix777/agent-handoffs/issues/N` with the exact optional `#issuecomment-ID`. A legacy Markdown/commit receipt does not qualify. Current trusted API fields `agentAck` and `agentResult` are null, so both stages explicitly remain unconfirmed; arbitrary telemetry or unrecognized objects cannot promote them.

After a pending enqueue, the visible page checks the owner-scoped GET queue after 1s, then 2s, then 5s (8s total). It stops on terminal receipt/error/conflict, hidden page or auth invalidation. This is bounded read-only polling, not a new producer, timer service or executor trigger. The UI shows SAVED immediately and a pending fallback if delivery has not been observed. It does not promise live instant delivery. `delivery.status: not_configured` explicitly says the GitHub Issues channel is not connected.

Additional real Edge browser contract checks (synthetic API only): two author snapshots; issue/comment receipt links; four-stage separation; rejection of legacy Markdown receipts as Issues delivery; saved-immediately followed by one bounded GET obtaining a verified-format issue receipt without a second POST or a 60-second wait. Production delivery, token installation, account mapping, ACK and result are not established by these UI tests.
