# Independent Hub acceptance evidence

Date: 2026-10-25. Reviewer: the dedicated QA subagent, separate from UI, ingestion, outbox and adapter authors. Current canonical Issues implementation tested through `e49933a`: **22/22 independent browser acceptance checkpoints passed**. No production deployment, migration or real GitHub Issues write was performed by this QA run. Historical 14-check baseline evidence is retained below and does not supersede the current Issues contract.

## Current canonical Issues acceptance

The expanded harness uses actual `worker.fetch(request, env, ctx)`, real SQLite with migrations 0001/0002/0003, and actual server-side Issues delivery code scheduled through `ctx.waitUntil`. Only the GitHub wire responses are synthetic. Both authors are explicitly mapped by stable synthetic Hub user ID, username and GitHub login. A third account remains denied even when the legacy owner list contains its username. No real owner mapping is inferred or deployed.

The synthetic GitHub fixture verifies new issue POSTs contain only the existing `idea` label, with no worker assignment or ready/execution label. Answers create comments on the configured existing task issue and leave its worker/cloud-state labels untouched. Delivery requires a separate exact readback. SAVED, DELIVERED, ACK and RESULT remain distinct; neither an Issue receipt nor a legacy Markdown receipt establishes an agent ACK/result.

```text
node --experimental-sqlite tests/hub-acceptance-browser.cjs
PASS owner privacy before any source read
PASS CSRF and payload validation
PASS durable idempotency, conflict and owner isolation
PASS two explicit stable-ID authors are attributed immutably; legacy third user and forged author denied
PASS actual Worker ingestion renders board, review and historical ideas
PASS modal focus, Escape and browser back
PASS owner answer persisted in actual SQLite and shown after browser reload
PASS mini-chat persistence/reload and owner text XSS safety
PASS lost POST response retries same immutable id without duplicate SQL record
PASS source version conflict does not overwrite or enqueue stale answer
PASS UI keeps conflicting draft and accepts it only after fresh context reopening
PASS actual Worker waitUntil delivers synthetic Issue comment; stale CAS and legacy blob cannot claim Issues delivery or ACK
PASS saved state appears before background flush; bounded GET polling displays idea-only delivery without execution or ACK
MEASURE natural-clock local synthetic click-to-visible-Issues-receipt 1467ms; no browser clock installed/advanced; NOT live GitHub latency
PASS natural browser timer shows receipt within 10s with one POST and unknown ACK/result
PASS second mapped author delivers under stored attribution and cannot read the first author queue
PASS failure before GitHub write stays durable; visible Retry preserves original key and delivers once
PASS expired durable intent reconciles accepted timeout under four concurrent leases without second GitHub POST
PASS negative reconciliation is not proof of failed create: absent ambiguous issue stays durable with no repeat POST
PASS definite remote conflict is persisted as conflict and never overwrites another edit or repeats POST
PASS visible-tab periodic update and honest source-error/stale-telemetry states
PASS 390px mobile layout and modal fit without horizontal overflow
PASS authorization loss clears board/outbox/telemetry and rejects delayed private response
RESULT 22 passed; synthetic GitHub only; browser board requests 12
```

The **1467ms** measurement uses a separate browser context without clock instrumentation and includes the natural one-second foreground polling delay. It measures the local synthetic path only. Another scenario advances a simulated clock to test polling deterministically; its wall execution duration is explicitly diagnostic and is not user-perceived or live latency. Neither number measures Cloudflare or real GitHub network latency.

The latest subpath traversal still passed **63/63**, including the revised explicit GitHub Issues not-configured state. CI runs the expanded harness through its existing acceptance command; the new `hub-acceptance-issues-fixture.cjs` never contacts GitHub.

Independent review found two further security/state issues, both corrected by the implementation owners and verified in this harness:

- An explicit author map originally fell through to the legacy username allowlist for unmatched users. Explicit mapping is now authoritative and requires both stable ID and username; stale third users and forged author fields are denied.
- A definite remote body/destination conflict originally returned `conflict` but persisted `delivery_uncertain`. The persisted state now remains `conflict`, retains its delivery intent and is not automatically reclaimed. Genuine timeouts and absent-marker reconciliation remain uncertain and never authorize a second POST.

The real SQLite race test starts four competing flushes after a simulated lease expiration and confirms one reconciliation winner with only the original GitHub POST. A create that may not have arrived is deliberately **not** resent after negative reads. The visible Retry button submits the original persisted idempotency key and payload; it does not fabricate a new message ID. Confirmed delivery and conflicts do not expose that retry action.

[Synthetic Issues receipt with second-author attribution and unknown ACK/result](../../artifacts/hub/issues-receipt.png)

## Historical baseline

Product code was initially tested through `3dfdfbf`, with the first harness committed as `281a2ea`. Root independently reran that 14-check baseline. Its receipt-import scenario was a local Markdown proof only; it is retained as historical evidence and is now explicitly rejected as canonical Issues delivery by the expanded test.

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
[English translation of the Russian result] Total: 63 passed, 0 failed.

node --experimental-sqlite --test test/subpath-server.test.js
tests 1; pass 1; fail 0

npm run check
[English translation of the Russian result] 5 of 5 pages and 5 scripts OK.
[English translation of the Russian result] Manifest OK: 31 entries.
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

## Additional release-audit review

The same independent reviewer inspected release-audit change `a8cc6b8399cc834890fb722616da2a13452b0d8d` in its source worktree and reran `node --test test/release-audit.test.js`: **7 tests, 7 passed, 0 failed**. `node tests/check-downloads.cjs` validated **36 catalog records**. The earlier 31-record check above predates this separately reviewed catalog update.

Review found that optional binary hashing originally used independent 60-second timeouts rather than the audit's shared deadline. The author corrected redirects and streamed body processing to use the remaining shared budget, and added an expired-budget/no-network test. The test root now uses `fileURLToPath` so paths containing spaces resolve correctly. The fixed source was reviewed before acceptance.

The protected Location Fusion path and its exact metadata checks remain unchanged. Doktor 1.0.3 now uses the exact release asset URL while preserving its size/digest guards. Added AAB entries state that they are store packages and cannot install directly; unsigned IPA entries remain labeled previews with device installation unverified. The CLI reads existing `gh` authentication internally, performs no remote writes and creates no timer. Publication tag resolution is explicitly separate from source-build provenance.

This was a lightweight source/test review. The independent reviewer did **not** repeat the live binary downloads. The source author's download hashes and metadata evidence require separate root verification and do not establish signing, device installation, production approval or the scheduled audit's activation.

## Visual evidence

All images contain synthetic fixtures only. Desktop and mobile screenshots were inspected visually; modal images use the viewport rather than a full-page capture of the background document.

- [Desktop board](../../artifacts/hub/desktop.png)
- [Desktop modal](../../artifacts/hub/task-modal.png)
- [390px mobile board](../../artifacts/hub/mobile.png)
- [390px full-screen modal](../../artifacts/hub/mobile-modal.png)

The CI workflow now runs the UI contract and the actual-Worker browser acceptance after installing Chromium, then uploads these synthetic screenshots. Linux uses the Playwright-installed browser. Remote CI success must be checked for the final PR SHA; local success is not a substitute.

## Remaining acceptance dependencies

Production authenticated UI, approved D1 migration/rollout, activation of a separately authorized narrowly scoped Issues credential, verified real owner mappings, real GitHub Issues delivery and a live executor ACK/result remain outside this report's proof. The new `ctx.waitUntil` Issues transport was tested locally with synthetic responses; it was not activated in production. The earlier Markdown CAS experiment is a separate historical leg and cannot count as canonical Issues delivery. No timer, Claude/Doctor session, production security setting, secret or token permission was changed by QA.

## Self-check

The requested independent UI/backend boundary was exercised, not a neighboring product. Existing Node SQLite and Playwright dependencies were reused. Synthetic sessions and GitHub records are explicit assumptions; production identity/transport remains unproven. Empty/error/stale data, repeated requests, lost responses, source conflicts, version CAS, multiple owners and delayed responses after authorization loss were checked. No private transcript, real idea contents or credential values appear in fixtures or screenshots. Checks and limits are listed above; no claim is made that this run completed live delivery.
