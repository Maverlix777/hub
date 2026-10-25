# Hub implementation and acceptance plan

Status: draft PR [#40](https://github.com/Maverlix777/hub/pull/40), 2026-10-25. Audit/catalog PR41 merged after review and passing CI. Root's final core suite passed **200/200** at `e49933a`; final independent browser acceptance passed **22/22**, QA commit `e753d998d0ffa5ed36a706acc7e24b7db150e405`, with synthetic Issues. Final integrated-head remote CI verification remains pending. Production activation, real Issues delivery/latency and executor ACK remain pending. The evidence below is scoped and is not a production completion claim.

Latest scope extends the earlier baseline: canonical GitHub Issues, rapid server-side flush after durable enqueue, and two explicitly mapped authors. Their current core implementation is exercised by the expanded synthetic 22-check browser suite; the earlier markdown delivery leg and `281a2ea` checks alone do not establish their acceptance. Outbox owns stable ID/username author validation; Snezhanna integration owns Issues creation/comment delivery with trusted routes. Production credential/configuration activation remains unapproved; the concrete approval question is pending a response.

Use the verified existing task bus labels (`worker:claude|codex|snezhana`, `cloud:ready|running|done|blocked`). Ideas remain read/discuss-only until explicit owner execution approval. Source documents do not authorize credential or scheduler changes. The separate Issues writer needs no Contents permission.

## Workspace and baseline

Integration checkout: `hub/` relative to the dedicated workspace; exact local paths are recorded in the private handoff.
Integration branch: `codex/hub-interactive-owner-workspace`.
Base commit: `aed28b21116fe3559937face10c9a9c66e2e34f6`.
All implementation worktrees below are siblings of the integration checkout and begin at that base. Existing earlier checkouts are left intact.

The available Codex project API lists existing projects but provides no supported create-project operation in this session. A dedicated checkout and task are available; a sidebar project has not been created. Do not conflate these objects.

## Team and ownership

The inspected main workflow is `umpa-orchestrator` at `agent-handoffs:proposals/ai-factory-jobforge/skills/umpa-orchestrator/SKILL.md`. Codex collaboration tools are available with seven total slots including the orchestrator. The plan reserves one slot for independent QA. Agents inherit the actual Codex model unless explicitly recorded otherwise; no Claude Sonnet/Haiku execution is implied. There is no close-agent API; a completed agent is idle, not proven deleted or stopped as an OS process.

| Owner | Branch / worktree | Owned files | Deliverable |
| --- | --- | --- | --- |
| Orchestrator | `codex/hub-interactive-owner-workspace` / `hub` | Integration decisions and final acceptance | Review diffs, integrate commits, run acceptance, produce draft PR and verified report |
| Plan | `codex/hub-plan` / `hub-plan` | `docs/hub/MASTER-PROMPT.md`, `PLAN.md`, `CONTRACT.md` | Sanitized master prompt, matrix, shared boundaries |
| UI | `codex/hub-ui` / `hub-ui` | `public/apps/board.*`, separately agreed UI tests | Light responsive interface, accessible card dialog, questions/chat, receipts and freshness |
| Ingestion | `codex/hub-ingestion` / `hub-ingestion` | `src/board.js`, `src/board-sources.js`, ingestion tests; after original delivery, separately scoped link/release audit tools and tests | Canonical-source discovery, normalized task/idea details and explicit source states; inventory and read-only freshness audit for all Hub apps/downloads |
| Outbox | `codex/hub-outbox` / `hub-outbox` | `src/worker.js`, `src/outbox.js`, migrations, outbox tests | Explicitly mapped-author persistence/API, validation, CSRF/rate limits, idempotency and receipts |
| Snezhanna integration | `codex/hub-snezhanna` / `hub-snezhanna` | `tools/hub-outbox*`, integration tests and integration documentation outside the three plan-owned files | Existing-writer adapter, bounded task routing, retry/CAS/receipts, no new scheduler |
| Independent QA | Dedicated QA agent; final evidence commit `e753d998d0ffa5ed36a706acc7e24b7db150e405` | Dedicated QA harness/evidence agreed with root; product defects returned to owners | Independent security/functionality review, actual-Worker browser checks, synthetic board/modal and Issues-receipt screenshots |

Each implementer reads applicable instructions, works only in its checkout/files, commits a bounded change, and reports SHA plus self-check. Shared interfaces are coordinated before integration. New source loading in `src/worker.js` belongs to Outbox; Ingestion supplies the callable module contract. No simultaneous editing of that shared file.

## Sequence

1. Inventory the existing repository, instructions, auth/storage, private source locations, and authorized writer. Save the master prompt and matrix before product implementation.
2. Agree concrete request/response shapes in `CONTRACT.md`; notify all affected owners before changing them.
3. Implement independent streams with synthetic tests. Record exact storage/security dependencies without granting privileges or changing live scheduling.
4. Integrate bounded commits. Inspect diffs and independently rerun meaningful checks. Send defects back to the file owner.
5. Run browser QA against the integrated local build, including mobile and keyboard flows. Record mocked, local persisted, and live paths separately.
6. Create a draft PR with exact head SHA and checks. Publish the detailed sanitized/private report in the proper repository and verify remote content before returning its link. Leave deployment and unresolved grants explicit.
7. Following original ingestion delivery, audit every Hub app/download link against canonical GitHub release/tag/commit/asset data. Verify availability and hashes where available, identify the latest verified suitable artifact, and record source/time plus stale/broken/unknown status. Expose the read-only audit to the existing heartbeat; do not create a timer. Integrate scoped corrections, and merge only relevant reviewed PRs whose required CI and blockers are clear. Retain drafts where live dependencies are unresolved; production activation remains separate.

## Acceptance matrix

| ID | Scenario | Required evidence | Verified state / remaining boundary |
| --- | --- | --- | --- |
| UI-1 | Light desktop/mobile board with four work statuses | Browser screenshots at desktop and mobile widths; no clipping | Verified locally, desktop and 390px mobile; production UI pending |
| UI-2 | Card details and keyboard accessibility | Browser test of activation, dialog content, focus trap/restore, Escape and Back | Verified in actual-Worker browser harness |
| DATA-1 | Existing ideas recovered | Canonical paths/revisions and source-format analysis; no private content committed publicly | 33 historical records parsed locally from three inspected sources; not an active registry or production display claim |
| DATA-2 | Empty/error/loading distinct | Parser/source tests plus browser failure/empty states | Local tests and browser source error/stale cases passed |
| MSG-1 | Owner question reply persists across reload | Authenticated API/local storage integration plus browser reload | Actual Worker + SQLite + browser reload passed; production D1 rollout pending |
| MSG-2 | Chat uses same persisted outbox | Browser synthetic message with durable pending receipt | Actual Worker + SQLite + browser reload passed; production transport unconfigured |
| MSG-3 | GitHub delivery and receipt | Real authorized synthetic target write/readback; separately mark mock-only results | Isolated actual GitHub CAS/readback and duplicate no-write verified; scheduled browser-to-agent E2E pending |
| MSG-4 | Duplicate/retry/conflict safe | Same-id identical/different payload tests, transient retry, CAS conflict and concurrency | Local/browser and adapter tests passed; isolated remote duplicate recovery verified |
| SEC-1 | Owner-only access and CSRF | Anonymous/non-owner/missing-origin/cross-origin API and page tests | Local tests and actual-Worker browser checks passed; production passkey login pending |
| SEC-2 | XSS, validation, rate limit, no token exposure | Malicious text rendered inert; size/type tests; limit test; asset/source inspection | Local tests/static review/browser XSS and auth-loss race checks passed |
| AGENT-1 | Correct existing agent routing | Allowlisted target/adapter tests and ACK evidence; arbitrary text never executed | Typed adapter tests passed; real correct-executor routing and ACK pending |
| AGENT-2 | Existing periodic check and honest freshness | Read existing mechanism; timestamp/stale/missing browser states; no new timer | Existing mechanism inspected; browser refresh/stale states passed; scheduled outbox transport not activated |
| QA-1 | Independent review and reproducibility | Reviewer findings, commands/results, screenshots and exact commit | Final independent 22/22 browser checks, 63/63 subpath checks and synthetic screenshots at `e753d99`; Root separately repeated 22/22 |
| SHIP-1 | Draft PR and truthful remaining work | Verified PR URL/head SHA/checks; deployment and grants explicitly not claimed | Draft PR40 checks passed at `281a2ea`, deployment skipped; later heads need their own CI |
| FRESH-1 | Complete app/download inventory | Every current Hub application and download entry mapped to canonical repository/release/tag/commit/asset or explicitly unresolved source | 36 download entries and five apps inventoried; PR41 merged |
| FRESH-2 | Latest suitable artifact is available | Authorized GitHub asset/link readback, verification time, hash comparison when available, suitability/release criteria; no unstable-HEAD substitution | 34 metadata-verified, one declared unavailable, one protected access-unverified; no full binary/installability or deployed-catalog claim |
| FRESH-3 | Honest stale/broken/unknown states | Audit tests for missing release, inaccessible/private asset, broken link, mismatch, stale data and unavailable hash; provenance retained | Scoped audit tests/CI passed; protected access remains unknown rather than broken |
| FRESH-4 | Existing heartbeat and access boundaries | Read-only audit consumption evidence, no extra timer, private/payment/entitlement flow preserved | Protected flow unchanged; existing heartbeat amendment blocked by supported API environment; no new timer |
| FRESH-5 | Scoped ready integration | Relevant PR list with reviewed SHA, required CI results and blocker disposition; no unrelated mass merges or implicit production deploy | PR41 merged after 59-second CI pass; no Worker deploy or unrelated branch merges |
| ISSUES-1 | Canonical issue/comment delivery after durable enqueue | New-message issue creation and trusted-task comment routing, persisted verified receipts, duplicate/uncertain recovery tests | Expanded actual-Worker/SQLite browser suite passes with synthetic Issues; real Issues delivery pending |
| ISSUES-2 | Owner and approved collaborator author identity | Stable Hub ID plus username mapping; unmapped/mismatched accounts denied; no inferred GitHub-to-Hub mapping | Implementation tested with synthetic mapped authors; real collaborator mapping unresolved; production disabled |
| ISSUES-3 | Rapid live delivery and separate agent outcome | Measured real Issues delivery latency, issue/comment receipt, separate executor ACK and result | Natural/live latency and real ACK/result unverified; concrete credential approval question pending |

## Open dependencies

- Ingestion established three historical sources and their blob revisions; the previous two-board-only loader and restrictive ID-table parser omitted their numbered tables/prose. Production source display remains unverified; no active registry is inferred.
- Production storage availability and any schema migration authorization must be established before release. Outbox inspection found existing manager publication authority limited to telemetry, with direct Hub writes explicitly excluded. A separate approved transport/scope is required for live owner-message delivery; implementation must remain honest about `delivery.status: not_configured` until that dependency is resolved.
- Existing telemetry publication alone does not establish owner-message delivery or authenticated UI functionality.
- If no authorized live delivery route is available, retain tested code and synthetic evidence, report the exact dependency, and do not label MSG-3 passed.
- GitHub release metadata, artifact existence, and artifact suitability are separate checks. A successful URL request alone does not prove that an artifact is current, verified, installable, or permitted for the requesting account. Missing hash or insufficient private access remains unknown, not a fabricated pass.
- The supported automation API returned `Automations are only supported for local threads.` in this delegated environment. The existing schedule remains unchanged; its raw configuration was not edited. Read-only freshness audit consumption must be enabled through the same existing heartbeat from a supported context, not via a second timer.
- Proposed rapid Issues delivery needs a separately approved `HUB_ISSUES_GITHUB_TOKEN` limited to Issues read/write and Metadata read on the private task repository, stored only as an encrypted secret on the existing Worker. No Contents write or board-token expansion is allowed. The second author's exact Hub ID/username mapping is unresolved and must not be guessed. Neither proposed configuration is active.

## Evidence summary

See [QA.md](QA.md) for the actual-Worker browser method and limits. At `281a2ea`, Root independently reran core tests: **163/163**, zero failures; browser acceptance: **14/14**. Subpath checks: **63/63**; fixture server: **1/1**. Static checks passed after preserving the artifact allowlist while correcting Windows path/UTF-8 handling. Wrangler dry run produced a **745.55 KiB** bundle without deployment. These runs precede the final release-audit additions. PR40 remote checks passed in **56 seconds** at `281a2ea`, run `40184896479`, job `121143512187`; deployment was skipped. The earlier outdated-fixture failure was fixed and rerun, not waived. Later heads require their own CI.

Separate scoped audit/catalog [PR41](https://github.com/Maverlix777/hub/pull/41) merged at `64af04bb43f0de7150341fa7241ee3f8b02de137` on 2026-10-25 at 10:41:00 UTC. Reviewed head `a7fab14b8a68c223272fd354099271213943f33c` passed remote CI in 59 seconds, run `40185639064`, job `121145727155`. Root's metadata audit covers 36 download entries and five apps: 34 entries metadata-verified, one declared unavailable, one protected access-unverified; this is not a binary-hash or production-installability pass. The audit has a nine-second budget. Protected access was unchanged. Root merged main into the interactive branch cleanly. Interactive PR40 remains draft for unresolved transport/activation dependencies; no Worker deployment occurred.

Root's final core suite passed **200/200**, with zero failures or skips, at `e49933a`, including the conflict and visible retry corrections. Final independent expanded browser acceptance passed **22/22**, QA commit `e753d998d0ffa5ed36a706acc7e24b7db150e405`, using actual Edge, Worker and SQLite with synthetic Issues. Root separately repeated **22/22** on that code. Subpath checks passed **63/63**. Natural wall-clock local click-to-receipt measurements were **1,467 ms** independently and **1,426 ms** in Root's repeat, with one-second foreground polling; the network endpoint was synthetic, so neither is live GitHub or production latency. Virtual-clock timings are excluded. Integrated-head remote CI remains pending at this document revision. A read-only probe of the existing production deployment returned anonymous board API **401**, board page **302**, and login page **200**; it does not establish deployment of this new code or authenticated production access. Task bus labels were independently verified through GitHub. The parent confirmed the concrete token/configuration question was forwarded to the owner in the main chat; the response remains pending, with no credential activation authorized or performed.

The actual GitHub connector CAS/readback leg used one explicitly synthetic private report and verified immutable content/hash, then returned `already_verified` with no second write. Private receipt details are recorded only in the authorized private report. This leg does not meet the latest canonical GitHub Issues requirement, measure rapid delivery latency, prove production outbox extraction, or establish an agent ACK/result.

## Plan author self-check

Scope: only the three assigned planning documents were authored. Existing Worker architecture and boundaries are retained. Proposed API details require coordination with implementers; they are not implemented assertions. No private contents, owner transcript, credentials, deployment configuration, or runtime snapshot is copied here. Documentation validation uses diff inspection and whitespace checks; no product test or live delivery claim follows from it.

## Dashboard-first UI work

The owner selected a dashboard-first homepage. The concrete scope, separate routing/UI ownership and acceptance checks are in [DASHBOARD-FIRST-PLAN.md](DASHBOARD-FIRST-PLAN.md). This is separate from the incident diagnostic patch. Keep prior evidence above as historical evidence; new integrated code requires its own verification and release authorization.
