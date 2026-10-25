# Canonical Hub delivery: GitHub Issues

This supersedes the Markdown delivery prototype in `tools/hub-outbox-delivery.mjs`. The earlier synthetic document write/readback proves only that historical GitHub Contents leg. It is not evidence for the Issues transport, production delivery or executor ACK.

## Behavior and authority

`src/issues-delivery.js` exports `flushIssueDelivery(db, env, itemId, options)`. The Worker calls it via `ctx.waitUntil` only after a successful durable enqueue. This gives an immediate delivery attempt without claiming a latency guarantee. No new timer, daemon or Claude session is started.

- A new mini-chat message creates one issue in the existing **private** `Maverlix777/agent-handoffs` repository, labeled **`idea` only**. It does not set `cloud:ready`, assign an executor, or execute owner text.
- An answer to an existing task adds a comment to the exact issue selected by the server's trusted `HUB_ISSUES_TASK_ROUTES` mapping: `{sourcePath,taskId,issueNumber}`. The client does not choose a GitHub repository or issue number. Unknown or ambiguous routes fail closed.
- The taskbus labels are `worker:claude`, `worker:codex`, `worker:snezhana` and `cloud:ready`, `cloud:running`, `cloud:done`, `cloud:blocked`. They are not invented `to:*` labels. This change does not add any execution label to an idea; explicit owner approval and existing taskbus policy remain required before execution.
- Author attribution comes from the server-persisted `{hubUserId,hubUsername,githubLogin}` record. The GitHub token holder's account is not presented as the original owner. Missing account mapping is shown honestly as `not mapped`.
- Owner input is preserved in a code fence longer than all input fences. It is data, never shell, JavaScript, an instruction to change route, or permission to alter an agent session.

Taskbus source references were verified read-only by the coordinator: canonical AGENTS blob `9f4c230ed8bb4bf6c4873445153299a3c7908ea1`; `handoffs/snezhana-agent-bus/20261025T1100Z/HANDOFF.md` blob `b560169f76fee513d6c563d21587fc7ed517d331`. The runtime checks private repository metadata, `has_issues`, and existence of the exact `idea` label before a new issue POST. It never creates labels.

## Durable delivery and recovery

The D1 store atomically claims an item with an attempt ID and bounded lease. Before any non-idempotent GitHub POST it persists a closed intent containing the exact body, destination, marker and payload hash. A concurrent flush cannot claim that same item. A previous attempted intent may be reconciled but may never be blindly resent.

The marker is `hub-outbox:<durable-id>:<payload-sha256>`. The hash binds owner attribution, kind, text, source target and mapped issue. Changed mapping or payload under an existing intent is a conflict.

After GitHub POST, the transport validates the returned repository/issue/comment URL and independently fetches the created issue or comment. Only exact body readback yields a typed receipt:

```json
{
  "kind": "comment",
  "url": "https://github.com/Maverlix777/agent-handoffs/issues/42#issuecomment-101",
  "issueNumber": 42,
  "commentId": 101,
  "deliveredAt": 1000
}
```

`synced` means **GitHub delivered/read back**. It is distinct from **saved in Hub**, **executor ACK**, and **executor result**. ACK/result are unknown unless separately supplied by verified taskbus evidence.

Timeouts, rejected POSTs, missing readback, or crash after intent retain uncertain state. Later bounded reconciliation scans existing issues or comments for the exact marker, detects duplicates, and independently reads a match. A missing marker, truncated scan (maximum 10 pages), or API failure never authorizes another POST. Operator resolution is required if certainty cannot be established. This favors avoiding duplicate owner instructions over silently retrying an ambiguous create.

GitHub API calls share one **25-second wall-clock budget**, leaving time within the Worker background lifetime for durable outcome recording. Each request is additionally limited to 10 seconds or the remaining shared budget, whichever is shorter; that deadline includes streamed response-body reads. The reader rejects/cancels after **1 MiB of bytes**, without buffering an unbounded response first. A stalled stream also times out. Exhaustion before a POST is a safe error; exhaustion after a persisted attempted intent remains uncertain and never authorizes resend. Redirects are disallowed. Error states use fixed codes, without logging token, owner text or upstream response bodies. The implementation uses standard `fetch` and Web Crypto APIs; no dependency was added.

## Minimal credential proposal — not created or activated

Create a **fine-grained GitHub personal access token** under an account already authorized for `Maverlix777/agent-handoffs`, selecting **only that repository**:

| Permission | Level | Purpose |
| --- | --- | --- |
| Issues | Read and write | Read/create issues, list/create comments, apply the existing `idea` label |
| Metadata | Read-only | Verify the exact private repository and availability of Issues |

No Contents write/read grant is needed for this new token. The existing read-only `BOARD_GITHUB_TOKEN` continues reading board/idea source files and is not widened or repurposed. No Actions, Administration, organization, account or other repository permissions are required.

Store the approved token only as the encrypted Cloudflare Worker secret **`HUB_ISSUES_GITHUB_TOKEN`** on the existing **`kolobovdjp-hub-next`** Worker. Do not place it in frontend JavaScript, repository files, chat, logs or a browser storage key. Set `HUB_ISSUES_ENABLED=true` only after the reviewed migration/configuration and secret setup are explicitly approved. The module requires both that flag and a nonempty token of at least 20 characters; this length check is not a validity assertion.

Populate trusted issue routes from reviewed canonical taskbus mappings and authenticated author mappings on the server. Do not infer them from arbitrary owner text. The secret's value must not be read back or printed. Creation/installation/activation remains a separate approval step; this implementation did not perform it.

## Existing heartbeat fallback

The existing `try1-jobforge-read-only-reconciliation` heartbeat is the only permitted periodic fallback. Its current telemetry-only protocol does not authorize Issues delivery. This change does not edit its prompt, timers or sessions. A narrowly reviewed amendment and authenticated access to due/uncertain Hub items are still needed before claiming periodic fallback operates. It must reuse the same lease/intent/reconciliation path, not start a second writer or bypass uncertain state.

## Tests and remaining evidence

`node --experimental-sqlite --test test/issues-delivery.test.js` passed **23/23 tests**. The first 17 use synthetic API responses and a controlled store to test transport behavior: new issue, mapped comment, private metadata, missing/duplicate routes, exact label preflight, inert input, trusted author, immediate concurrent calls, intent-before-POST, timeout after a side effect, readback failure, uncertain reconciliation, duplicate markers, wrong repository and changed content. Two further tests integrate the actual `src/outbox.js` store with SQLite and all three real migrations: four concurrent flushes produce one POST and one persisted receipt with author attribution; a comment POST with simulated ambiguous timeout retains intent, blocks an early claim and reconciles after lease expiry without a second POST. Four budget tests cover aggregate preflight deadline, expiry after POST retaining uncertainty, cancellation of an oversized stream and an actually stalled stream timing out. GitHub remains synthetic in these tests. The outbox owner's separate tests cover additional database lease cases.

No live Issues token, issue/comment POST, authenticated production browser or scheduled Issues tick was exercised by this task. The old real Markdown report receipt is not relabeled as Issues delivery. Final acceptance still needs an approved synthetic **Issues** write/readback using the deployed owner path, verified D1 persistence/reload, periodic fallback, and explicit separation of executor ACK/result.

Self-check: implemented the newly requested Issues boundary, reused existing Worker/D1 infrastructure, kept credential and timer changes inactive, preserved owner attribution, and tested repeated/partial/uncertain outcomes. The transport's trusted inputs are persisted authenticated authors and server route mappings; incorrect configuration fails closed instead of redirecting owner text.
