# Hub delivery adapter: implementation and activation boundary

**Superseded:** canonical delivery is now GitHub Issues/comments; see [ISSUES-DELIVERY.md](ISSUES-DELIVERY.md). This document and `tools/hub-outbox-delivery.mjs` describe the historical Markdown prototype only. The Worker does not invoke it. Its synthetic live Contents receipt is not Issues or production E2E proof.

## Current result

`tools/hub-outbox-delivery.mjs` is an executable, dependency-free local preparation and reconciliation adapter. It makes no network requests, starts no timer, reads no credentials, and never runs owner-supplied commands. The existing Worker read-only GitHub token remains read-only.

Implemented protocol:

1. Obtain an owner-authenticated outbox item and a separately trusted route. The route names the existing task document, task ID, assigned agent and the only supported adapter (`github-task-document`). Owner text cannot select a repository, route, agent, executable or session. General messages require an explicit inbox route with `taskId: null`.
2. Through the existing authorized GitHub connector, freshly verify that `Maverlix777/agent-handoffs` is private, then read the exact existing destination content and blob SHA. The adapter refuses missing files, wrong repositories, public visibility, traversal paths and unrecognized adapters. Answers must match both source path and task ID, and their source revision must equal the current blob SHA. A changed task document produces a conflict instead of overwriting other authors.
3. Prepare an append to that existing document. Owner text is preserved inside a Markdown code fence longer than every backtick sequence in the input. The addition includes the exact task ID, existing assigned agent and stable receipt marker. It is data for that executor's authorized review; it does not execute instructions or wake a Claude/Doctor session.
4. Persist a private local pending intent atomically, with file flush and exclusive process lock, **before** returning the GitHub `update_file` proposal. Use its freshly read SHA as a CAS precondition. Do not use an unrestricted ref update or an alternate destination.
5. After the write, fetch the exact file at the returned commit SHA. Reconciliation requires `ref === commit`, exact resulting content hash and exact receipt block. Only then does it emit a `synced` delivery result with immutable GitHub receipt URL. Apply that result through `applyDeliveryResult(db, result, now)` in `src/outbox.js`; this uses the original outbox version as a CAS precondition. A database version conflict must not be overwritten.
6. On timeout or uncertain write, read back before considering any further action. A pending intent cannot be prepared again. Missing evidence remains `delivery_uncertain`, even if the observed blob is unchanged: that alone does not prove that the write never happened. Preserve intent and ask the operator to resolve it. A matching remote marker recovers without posting twice. A changed marker/body is a conflict.

`synced` means GitHub content was read back and verified. It does not mean an executor has ACKed, accepted or completed the task. Agent ACK and application evidence remain separate existing telemetry events. Unknown or old check timestamps must remain unknown or old.

## API contract

Inputs are JSON files supplied by the authorized operator, not fetched by this helper.

Outbox item (additional server metadata is ignored):

```json
{
  "id": "8ecf3881-954b-40a2-9a1b-79a4c1277d38",
  "idempotencyKey": "fe002bf4-cf52-42c1-881a-dbf71bb8d7b6",
  "kind": "answer",
  "text": "Synthetic owner answer.",
  "target": {
    "sourcePath": "reports/synthetic-board.md",
    "taskId": "HUB-1",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "status": "pending",
  "version": 1
}
```

Trusted route (no production route is installed by this change):

```json
{
  "repository": "Maverlix777/agent-handoffs",
  "path": "reports/synthetic-board.md",
  "branch": "main",
  "taskId": "HUB-1",
  "agent": "synthetic-agent",
  "adapter": "github-task-document"
}
```

Remote read is `{repository,path,branch,private:true,visibility:"private",sha,content}`. The helper independently computes Git's blob SHA-1 over the exact UTF-8 content and refuses a mismatch. An immutable readback additionally contains `{commit,ref}` with both set to the same 40-character commit SHA. These values must come from actual connector metadata and reads, not be inferred from an HTTP success status.

```sh
node tools/hub-outbox-delivery.mjs prepare /private/state/item-intent.json item.json trusted-route.json remote.json
node tools/hub-outbox-delivery.mjs reconcile /private/state/item-intent.json immutable-readback.json
node --test test/hub-outbox-delivery.test.js
```

Run under an already approved local identity. Keep item, state and connector proposal files outside published artifacts; they contain private owner input. A local intent lock left after a process crash requires operator investigation; never delete it automatically and resend. The helper returns fixed error codes and does not echo OS errors or paths.

## Exact activation dependencies — not completed by this code

The existing `try1-jobforge-read-only-reconciliation` heartbeat and its `TELEMETRY-PUBLICATION.md` were inspected read-only. That protocol authorizes **only** bounded publication to `runtime/try1/telemetry/current.json`; it explicitly excludes direct Hub writes and delivery. Its publisher prepares/validates locally and uses the GitHub connector for CAS write/readback. It has no outbox transport.

Therefore this change does not amend that timer, create another producer, enable disabled Claude delivery, modify manager runtime, or claim scheduled owner-reply delivery works. Activation needs all of:

- An explicitly authorized transport for the existing local writer to read owner-authenticated outbox items and import CAS delivery results into the existing Hub D1 database. No unauthenticated machine endpoint or new persistent credential is introduced here. The browser owner session route is not a machine credential.
- A reviewed trusted route registry mapping each supported source/task to the correct existing document and executor; an explicitly chosen existing inbox for new messages. No route may be inferred by executing or obeying owner prose.
- A narrow, owner-approved amendment of the **existing** heartbeat's scope to those outbox operations and destinations, with its existing bounded tick, STOP/pending/conflict handling retained. The telemetry-only grant is not an authorization for this amendment. No second timer is needed.
- Deployment/migration approval for the new Worker/D1 code, followed by authenticated production browser verification and a real scheduled observation. This implementation's tests are synthetic and do not satisfy those live checks.

## Validation and self-check

The synthetic Node tests cover exact destination, target/revision validation, preserved existing document content, immutable receipt verification, duplicate recovery, changed payload conflicts, ambiguous write blocking, missing task detection, typed inbox routing, inert owner markup, payload bounds, concurrent local locks and persisted intent across separate CLI processes. These are local adapter tests, not live GitHub or scheduled delivery evidence.

An initial CLI test failed because the execution sandbox redirected the OS temporary directory to a location where atomic rename returned `EPERM`. The test now creates its isolated temporary directory in its writable checkout; atomic persistence was not removed or weakened.

Self-check:

- Solved the assigned delivery adapter boundary, without changing unrelated products or sessions.
- Reused Node's standard library and the existing connector/CAS model; added no dependency or service.
- Assumes connector reads and trusted routes are supplied by an authorized operator. If that transport is absent, activation is blocked rather than simulated.
- Empty/missing/oversized inputs, changed source revision, duplicate/retry and partial/uncertain outcomes are tested; stale source revision never overwrites another author.
- Crosses only local JSON preparation → existing connector proposal → immutable readback → versioned D1 result. The actual connector and D1 transport are not invoked by this helper.
- User-visible `synced` is backed by an immutable content receipt, not confused with agent ACK or completed work.
- Live heartbeat, production transport and authenticated production UI remain unverified and inactive pending the explicit dependencies above.
