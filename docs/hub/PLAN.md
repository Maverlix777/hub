# Hub implementation and acceptance plan

Status: implementation kickoff, 2026-10-25. This document records scope and ownership, not a completion claim.

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
| Outbox | `codex/hub-outbox` / `hub-outbox` | `src/worker.js`, `src/outbox.js`, migrations, outbox tests | Owner-only persistence/API, validation, CSRF/rate limits, idempotency and receipts |
| Snezhanna integration | `codex/hub-snezhanna` / `hub-snezhanna` | `tools/hub-outbox*`, integration tests and integration documentation outside the three plan-owned files | Existing-writer adapter, bounded task routing, retry/CAS/receipts, no new scheduler |
| Independent QA | Assigned after interfaces stabilize | Dedicated QA evidence/tests agreed with root; no implementation ownership | Independent security/functionality review, real browser checks, screenshots |

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

| ID | Scenario | Required evidence | Initial state |
| --- | --- | --- | --- |
| UI-1 | Light desktop/mobile board with four work statuses | Browser screenshots at desktop and mobile widths; no clipping | Pending |
| UI-2 | Card details and keyboard accessibility | Browser test of activation, dialog content, focus trap/restore, Escape and Back | Pending |
| DATA-1 | Existing ideas recovered | Canonical paths/revisions and source-format analysis; no private content committed publicly | Pending |
| DATA-2 | Empty/error/loading distinct | Parser/source tests plus browser failure/empty states | Pending |
| MSG-1 | Owner question reply persists across reload | Authenticated API/local storage integration plus browser reload | Pending |
| MSG-2 | Chat uses same persisted outbox | Browser synthetic message with durable pending receipt | Pending |
| MSG-3 | GitHub delivery and receipt | Real authorized synthetic target write/readback; separately mark mock-only results | Pending |
| MSG-4 | Duplicate/retry/conflict safe | Same-id identical/different payload tests, transient retry, CAS conflict and concurrency | Pending |
| SEC-1 | Owner-only access and CSRF | Anonymous/non-owner/missing-origin/cross-origin API and page tests | Pending |
| SEC-2 | XSS, validation, rate limit, no token exposure | Malicious text rendered inert; size/type tests; limit test; asset/source inspection | Pending |
| AGENT-1 | Correct existing agent routing | Allowlisted target/adapter tests and ACK evidence; arbitrary text never executed | Pending |
| AGENT-2 | Existing periodic check and honest freshness | Read existing mechanism; timestamp/stale/missing browser states; no new timer | Pending |
| QA-1 | Independent review and reproducibility | Reviewer findings, commands/results, screenshots and exact commit | Pending |
| SHIP-1 | Draft PR and truthful remaining work | Verified PR URL/head SHA/checks; deployment and grants explicitly not claimed | Pending |
| FRESH-1 | Complete app/download inventory | Every current Hub application and download entry mapped to canonical repository/release/tag/commit/asset or explicitly unresolved source | Pending |
| FRESH-2 | Latest suitable artifact is available | Authorized GitHub asset/link readback, verification time, hash comparison when available, suitability/release criteria; no unstable-HEAD substitution | Pending |
| FRESH-3 | Honest stale/broken/unknown states | Audit tests for missing release, inaccessible/private asset, broken link, mismatch, stale data and unavailable hash; provenance retained | Pending |
| FRESH-4 | Existing heartbeat and access boundaries | Read-only audit consumption evidence, no extra timer, private/payment/entitlement flow preserved | Pending |
| FRESH-5 | Scoped ready integration | Relevant PR list with reviewed SHA, required CI results and blocker disposition; no unrelated mass merges or implicit production deploy | Pending |

## Open dependencies

- Canonical idea paths and their revisions must be established by Ingestion from authorized private sources; not guessed here.
- Production storage availability and any schema migration authorization must be established before release. Outbox inspection found existing manager publication authority limited to telemetry, with direct Hub writes explicitly excluded. A separate approved transport/scope is required for live owner-message delivery; implementation must remain honest about `delivery.status: not_configured` until that dependency is resolved.
- Existing telemetry publication alone does not establish owner-message delivery or authenticated UI functionality.
- If no authorized live delivery route is available, retain tested code and synthetic evidence, report the exact dependency, and do not label MSG-3 passed.
- GitHub release metadata, artifact existence, and artifact suitability are separate checks. A successful URL request alone does not prove that an artifact is current, verified, installable, or permitted for the requesting account. Missing hash or insufficient private access remains unknown, not a fabricated pass.

## Plan author self-check

Scope: only the three assigned planning documents were authored. Existing Worker architecture and boundaries are retained. Proposed API details require coordination with implementers; they are not implemented assertions. No private contents, owner transcript, credentials, deployment configuration, or runtime snapshot is copied here. Documentation validation uses diff inspection and whitespace checks; no product test or live delivery claim follows from it.
