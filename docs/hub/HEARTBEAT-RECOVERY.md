# Existing-heartbeat own-queue recovery — prepared, inactive

`tools/hub-outbox-recovery-plan.mjs` is a pure, executable admission and selection helper for **one existing visible retry control**. It does not open a browser, fetch an API, read cookies, copy credentials, create a session/timer, or execute message text. No new API endpoint or credential privilege is added.

Exact runtime automation/thread IDs, current prompt context and the proposed amendment belong only in the private operator handoff. They are supplied through a separately trusted policy file; no production identity is hardcoded here. A policy file is not authorization: the existing heartbeat must already have the explicitly approved narrow recovery scope.

## Existing UI and Worker reuse

The board's `.outbox-entry[data-receipt-id="<UUID>"] .retry-delivery` button resubmits the **same saved idempotency key and unchanged payload** through existing authenticated `POST /hub/api/outbox`. The Worker uses the canonical Issues transport, atomic leases, durable intents and uncertain-outcome reconciliation. The helper neither constructs a request body nor treats a retry as permission to repeat an ambiguous GitHub POST.

Selection is limited to one current author's visible pending/error record. It prioritizes never-attempted/least-recently-attempted records, then oldest creation time. A 30-minute per-record cooldown prevents one uncertain record monopolizing each 15-minute tick. Conflict, delivered, hidden, disabled, foreign-author or unverified rows are excluded. At most 100 observed rows and 500 recent journal entries are accepted. Partial pagination is reported honestly; there is no automatic extra page or second click.

## Private activation dependency

The currently inspected heartbeat has only its existing dispatcher and telemetry authority. It has no proven authenticated Hub browser transport and excludes general browser control/direct Hub writes. Therefore this helper is **not operational periodic recovery**.

After explicit approval, use the supported automation update tool on the **same existing automation ID and target thread from private policy**. Preserve every current prompt field, cadence, ownership/STOP/budget guard and telemetry exception; append only the private handoff's narrow browser-recovery exception. Never edit raw automation TOML or create another timer.

The proposed transport uses an **already authenticated, supported owner browser surface**. GitHub Issues credentials, the read-only board token and a telemetry connector do not authenticate Hub POSTs. Do not export cookies, inspect browser credential databases, acquire a new identity, enter passwords, or inject browser network requests. If the existing owner's identity/session cannot be proven, stop.

Scope is **the current authenticated author's own queue only**. One owner's session cannot inspect or drain another author's queue. All-author unattended recovery requires a separate explicit privilege and transport design; it is not provided here.

## Bounded operator procedure

1. Read exact existing automation/thread policy and authorization from the private operator handoff. Confirm the actual scheduled turn, self-ownership, STOP/busy/backoff/pending-work guards and at least 40 seconds of remaining permitted budget after preserving required existing phases. No authorization or budget means no action.
2. Use supported browser state/control to reuse a proven current owner session on the exact Hub origin. If explicit principal UI is absent, normal navigation to the existing same-origin session JSON page may provide username and owner board access **only if the approved browser exception permits it**. Return to the board. No cookie reading or injected `fetch`.
3. Capture only the closed metadata observation below, fresh within 30 seconds. Never save message prose or full browser/API responses. A positive explicit delivery-enabled value is required; generic UI hints or absence of an error are insufficient.
4. Run the helper with observation, admission and separately trusted policy. If it emits a stop/no-op, do not click. If it emits one retry selector, persist its `journalBeforeClick` locally and atomically before the click.
5. Recheck exact origin, current author, same row UUID and visible/enabled control. Click that existing retry control **once**. A changed page means stop, not automatic reselection.
6. Read the same record's displayed outcome within remaining budget. A valid GitHub Issues receipt proves delivery only, not executor ACK or result. Mark journal state verified only with that evidence; otherwise leave unconfirmed. Never repeat the click in the current tick. Later normal ticks apply cooldown/rotation and the same Worker reconciliation rules.
7. Record the actual scheduled turn/time and bounded metadata outcome. Do not self-message, manually run the schedule or start a daemon to manufacture scheduled evidence. Retain the existing telemetry exception unchanged and do not message/change executor sessions.

## Observation provenance

Use supported inspection of actually displayed state. Do not read page JavaScript closure state, storage/cookies, credentials or hidden application state.

| Field | Required evidence |
| --- | --- |
| `url`, `observedAt` | Actual tab URL and current observation clock |
| `ownerSessionVerified`, `username` | Explicit verified current principal UI; if unavailable, stop. Normal same-origin session-page navigation is only permitted under the approved private browser exception. |
| `delivery` | Explicit authenticated server `delivery.status` metadata or authorized operator evidence for the exact deployed configuration. Never infer enabled from a generic separation-of-stages hint. |
| Row `id` | Actual displayed row `data-receipt-id`, validated as UUID |
| `authorUsername` | Visible row author attribution, matching the verified principal exactly; missing/legacy attribution is not inferred |
| `status` | Consistent visible delivery stage and retry button text. Ambiguous, conflicting or unread states block selection. |
| `createdAt` | Exact server metadata timestamp or displayed date parsed with a proven locale/time-zone rule. Unknown dates are not guessed. |
| `retryVisible`, `retryEnabled` | Current visibility/enabled state of that exact row's retry button |
| `hasReceipt` | Valid displayed typed GitHub Issues/comment receipt, not an arbitrary link |
| `hasMore` | Actual pagination control or explicit own-queue pagination metadata; missing inspection is not false |

If exact timestamps or delivery metadata require viewing the own-queue JSON page, normal browser navigation must itself be sanctioned by the private exception. Extract only this metadata subset, never save owner prose, then return to the board. The helper makes decisions from proven observations; it cannot establish authentication itself.

## Closed input contract

```sh
node tools/hub-outbox-recovery-plan.mjs /private/observed-metadata.json /private/trusted-admission.json /private/trusted-policy.json
node --test test/hub-outbox-recovery-plan.test.js
```

Trusted policy: exactly `{automationId,threadId,scope}`. `threadId` must be a UUID, `automationId` a bounded lowercase/hyphen identifier, and scope exactly `recover-own-hub-outbox`. Actual production values stay in private operator configuration.

Admission: exactly `{automationId,threadId,turnId,approvedScope,authenticatedUsername,selfOwned,stopped,remainingMs,attempts}`. Runtime IDs and scope must equal trusted policy. Each journal entry is exactly `{turnId,itemId,state,attemptedAt}` with state `attempted`, `verified` or `unconfirmed`. Retain the current turn and all records in the cooldown window while bounding the journal; if safe retention cannot be established, fail closed instead of dropping anti-repeat evidence.

Observation: exactly `{url,observedAt,ownerSessionVerified,username,delivery,rows,hasMore}`. URL must equal `https://hub.kolobovdjp.org/hub/apps/board.html`. Each row is exactly `{id,authorUsername,status,createdAt,retryVisible,retryEnabled,hasReceipt}`. Times are integer epoch milliseconds. Owner prose and target instructions are not accepted fields.

## Verification and limits

Local planner tests: **10/10 passed**, including missing/invalid trusted policy, exact scope/identity matching, owner/browser/origin checks, stale data, author isolation, one-click journal, cooldown/rotation, budget, invalid selector IDs, injected prose and honest pagination limits. Inputs are bounded local trusted files; this CLI is not a network service.

No automation was amended, no browser session acquired and no production/scheduled recovery performed. No Worker or UI change is needed. Actual scheduled acceptance still requires the approved private amendment and a supported, already authenticated per-author browser in that existing target thread; the independent reviewer must not label planner tests as operational delivery.
