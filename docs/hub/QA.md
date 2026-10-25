# Independent Hub acceptance evidence

Date: 2026-10-25. Reviewer: the dedicated QA subagent, separate from UI, ingestion, outbox and adapter authors. Product code tested at `c79ed9d` plus the QA harness changes in this commit. Root performs its own integration checks. No production deployment or migration was performed by this QA run.

## Environment and proof boundary

Windows, Node 24.22.1, Playwright 1.56.1, installed Microsoft Edge in headless mode with a temporary isolated profile. The browser requested the real Hub HTML/CSS/JS. Request routing delivered browser requests to the actual `src/worker.js` entry point, backed by native SQLite running the repository migrations. A synthetic owner session was inserted using the same hashed-session schema as the existing Worker tests. GitHub source reads were synthetic file responses with matching Git blob hashes.

This proves browser/Worker/parser/SQLite behavior together. It does **not** prove production passkey login, Cloudflare D1 rollout, real owner responses, the scheduled publisher transporting the outbox, real GitHub delivery, or an assigned agent's ACK. The receipt test explicitly imports synthetic trusted evidence through the local CAS function; its URL is not a real delivery claim.

## Executed checks

```text
node --experimental-sqlite tests/hub-acceptance-browser.cjs
PASS owner privacy before any source read
PASS CSRF and payload validation
PASS durable idempotency, conflict and owner isolation
PASS actual Worker ingestion renders board, review and historical ideas
PASS modal focus, Escape and browser back
PASS owner answer persisted in actual SQLite and shown after browser reload
PASS mini-chat persistence/reload and owner text XSS safety
PASS lost POST response retries same immutable id without duplicate SQL record
PASS source version conflict does not overwrite or enqueue stale answer
PASS UI keeps conflicting draft and accepts it only after fresh context reopening
PASS simulated trusted receipt import uses CAS and renders persisted error/synced evidence (NOT live GitHub)
PASS visible-tab periodic update and honest source-error/stale-telemetry states
PASS 390px mobile layout and modal fit without horizontal overflow
PASS authorization loss clears board/outbox/telemetry and rejects delayed private response
RESULT 14 passed; synthetic GitHub only; browser board requests 9

node tests/check-subpath.cjs
Итог: 63 прошло, 0 упало

node --experimental-sqlite --test test/subpath-server.test.js
tests 1; pass 1; fail 0

npm run check
5 из 5 страниц и 5 скриптов ок
ok manifest: 31 запис.
public Pages artifact OK: 27 files, no docs/tests/tools
Pages migration redirects OK
```

Windows invocation used `HUB_BROWSER` for the preinstalled Edge executable in the subpath suite, and the normal user temporary directory. The first sandbox browser launch failed before page execution; a scoped approved elevated test launch succeeded. No safeguard or assertion was disabled.

The first acceptance-harness attempts exposed two harness mistakes: a closed dialog was incorrectly awaited as visible, and an unscoped text locator also matched the hidden detail title. The test now waits for the closed dialog's DOM presence and scopes card clicks to the questions section. Those failures were not product regressions.

## Review findings and corrections

- Fresh-context recovery retained a blocked draft flag after a source conflict. The UI owner fixed the transition; the independent actual-Worker browser scenario now demonstrates rejection of the stale revision followed by successful submission after reopening the fresh context.
- Auth loss previously left telemetry in the DOM and could be followed by a delayed successful request repopulating private data. Root identified this; the UI owner added terminal authorization invalidation and generation checks. The independent harness holds an earlier private board response, causes a later POST to fail for a non-owner, then releases the old response and verifies all private DOM stays cleared and controls stay disabled.
- Reopened mobile dialogs retained the previous internal scroll position. Both reviewers found this visually. The UI owner resets it; a new-open title-position assertion and the viewport screenshot verify the correction.
- Existing subpath fixtures lacked the new read-only outbox route and asserted the old English `unknown` string. The fixture now returns an explicitly unconfigured empty queue and checks the new Russian unknown/unavailable wording. Missing paths and wrong methods still return 404; the server unit test verifies this.
- The existing artifact test compared platform-specific path strings to URL-style paths on Windows. It now uses `as_posix()` and explicit UTF-8 decoding, preserving the exact allowlist and all safety assertions.

The review read the actual outbox validation, owner/Origin/header checks, immutable idempotency insertion, source revision binding, result CAS, source loading and typed adapter implementation. The adapter prepares a bounded task-document write and verifies immutable readback; it does not execute owner text. The current telemetry projection does not contain executor identity/evidence for every event, and the UI honestly shows missing values.

## Visual evidence

All images contain synthetic fixtures only. Desktop and mobile screenshots were inspected visually; modal images use the viewport rather than a full-page capture of the background document.

- [Desktop board](../../artifacts/hub/desktop.png)
- [Desktop modal](../../artifacts/hub/task-modal.png)
- [390px mobile board](../../artifacts/hub/mobile.png)
- [390px full-screen modal](../../artifacts/hub/mobile-modal.png)

The CI workflow now runs the UI contract and the actual-Worker browser acceptance after installing Chromium, then uploads these synthetic screenshots. Linux uses the Playwright-installed browser. Remote CI success must be checked for the final PR SHA; local success is not a substitute.

## Remaining acceptance dependencies

Production authenticated UI, approved D1 migration/rollout, the outbox extraction and receipt-import transport for the existing scheduled writer, routing to the correct existing executor, and a live executor ACK are not covered by this report. No timer, Claude/Doctor session, production security setting, secret or token permission was changed. Any separate live GitHub CAS experiment must be reported as that distinct leg, not as full browser-to-agent delivery.

## Self-check

The requested independent UI/backend boundary was exercised, not a neighboring product. Existing Node SQLite and Playwright dependencies were reused. Synthetic sessions and GitHub records are explicit assumptions; production identity/transport remains unproven. Empty/error/stale data, repeated requests, lost responses, source conflicts, version CAS, multiple owners and delayed responses after authorization loss were checked. No private transcript, real idea contents or credential values appear in fixtures or screenshots. Checks and limits are listed above; no claim is made that this run completed live delivery.
