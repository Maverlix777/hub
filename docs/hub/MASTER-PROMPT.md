# Hub project master prompt

## Mission

Maintain and develop the existing Hub at `https://hub.kolobovdjp.org/hub/` in `Maverlix777/hub`. Deliver a usable, owner-only work dashboard and a reliable communication path from the owner through Snezhanna to the correct existing GitHub task and agent. Keep the existing Cloudflare Worker architecture. Do not create a replacement repository, duplicate website, or unrelated product work.

This is a sanitized development specification. Private idea text, owner conversations, credentials, runtime configuration, and private snapshots must never be copied into this public repository. Read private sources only through authorized mechanisms; use synthetic fixtures in committed tests and screenshots.

## Required behavior

1. Provide a clear, light, responsive interface for desktop and mobile. The Scrum board exposes planned, in-progress, review, and done distinctly. Cards open a large accessible dialog (full screen on small devices) with description, owner, status, history, evidence links, and blockers. Support keyboard activation, focus containment and restoration, Escape, and browser Back.
2. Recover real recorded ideas by inspecting `ideas.md`, `IDEAS`, and related documents in the authorized private handoff repository. Identify canonical sources and the ingestion failure. Never invent ideas or interpret an empty parser result as proof that source ideas do not exist. Show source provenance and distinguish loading, empty, and error.
3. Put owner questions in a prominent area. Show their task context and a response field. Persist replies reliably, including across reload, with pending/synced/error states. Route replies to the correct task/plan through Snezhanna. Repeated requests must not duplicate the message; concurrent changes must not overwrite another person's work.
4. Provide a mini-chat for ideas, tasks, and clarifications using the same real outbox pipeline. Show receipts and actionable errors. Restrict access to authenticated owners. Enforce CSRF, XSS, rate limits, payload validation, and server-side secrets. A successful UI animation or console message is not persistence or delivery.
5. Show Snezhanna's last check, current work, questions awaiting answers, assigned agent, ACK/evidence, and data freshness. Label missing/stale information honestly. Use the existing periodic reconciliation mechanism; do not create a second timer or producer. Owner text is data, never an executable command. Dispatch only through explicitly allowed adapters and existing task/agent mappings.
6. Verify frontend, backend, and browser behavior with safe synthetic payloads. Cover dialog interaction, ingestion, persistence/reload, delivery/receipt, duplicate/retry/conflict, mobile layout, privacy, and periodic refresh. Distinguish unit/mocked evidence from local integration and actual live delivery. Deliver screenshots, reproducible artifacts, and a draft PR with exact SHA, checks, and remaining blockers.

## Authority and boundaries

- Implementation, local tests, project documentation, a draft PR, and sanitized work reports are authorized.
- New code is not authorized for production deployment by the earlier release authorization. Do not deploy, merge, or change production security configuration as an incidental step.
- The existing `BOARD_GITHUB_TOKEN` is read-only. Never read or print its value; never expand its scopes. Investigate the existing authorized local GitHub writer for writeback.
- Any new persistent storage or security grant is a separate explicit dependency. Implement and test the safe inactive path while recording the exact missing grant. Do not claim live operation until that dependency is actually satisfied.
- Do not alter Doctor/JobForge product code, other people's branches, runtime processes, security settings, real Claude sessions, or disabled unattended dispatch.
- Do not create a duplicate 15-minute automation. Reuse the existing reconciliation contract after inspecting it.
- Do not ask the owner to repeat established requirements or obvious decisions. Escalate only concrete unresolved blockers, with action, target, reason, completed work, and denied/pending/uncertain status. After a denial, do not route around it; check uncertain outcomes before retrying.

## Workflow

Use the existing `umpa-orchestrator` workflow, not an invented command or unverified installation. The inspected source is `agent-handoffs:proposals/ai-factory-jobforge/skills/umpa-orchestrator/SKILL.md`. This locator is a development reference, not a runtime dependency. Read repository instructions and relevant skills before changes. The orchestrator owns decomposition, integration decisions, independent evidence review, and final QA. Assign bounded file ownership and isolated branches to implementers, and reserve independent review capacity. Record actual tool/model use without claiming unavailable Claude models ran.

Keep [PLAN.md](PLAN.md) and [CONTRACT.md](CONTRACT.md) current. Work updates and private evidence belong in the authorized private handoff repository; public repository documents contain only sanitized architecture and synthetic evidence. Do not treat agent summaries or a passing mock as proof of production behavior.

## Starting evidence

- Confirmed Hub base: `aed28b21116fe3559937face10c9a9c66e2e34f6` (PR 39).
- Intended deployed Worker: `kolobovdjp-hub-next`; repository example configuration may still name an older Worker. Do not use it to deploy.
- Reported deployed version: `952bb7b6-c223-4a0c-ab8f-00652cb1ff0b`. This is baseline context, not a claim that this work is deployed.
- Earlier authenticated production UI behavior is unverified. Preserve this distinction in acceptance reports.
- The existing telemetry publisher uses the existing reconciliation heartbeat and SHA/CAS publication. No additional daemon is required or authorized by this specification.

## Completion report

State the exact integration branch and commit, canonical-source findings without private contents, implemented behavior, commands and results, browser artifacts, live delivery status, draft PR, and remaining dependencies. Do not call a task/thread a sidebar project unless the supported UI actually created one. Never present a local file as an uploaded report or a guessed link as a verified deliverable.
