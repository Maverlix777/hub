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
