# Hub source ingestion evidence

Investigated 2026-10-25. No private idea contents or conversation transcripts are included here.

## Findings and selection

The authenticated GitHub tree API returned agent-handoffs main tree `297e9b64046adb4dbb082c0651f9e94f70ee8922`. Its recursive path listing contains no file named literally `ideas.md` or `IDEAS`. This does **not** establish absence of ideas.

Existing source records selected explicitly:

| Record | Git blob SHA | Parser result on local source | Classification |
|---|---|---:|---|
| `reports/2026-10-21-case-studio-start/ideas-3dprint-apps.md` | `f6327a4356543792385e1bb8ba501544aaa17a1e` | 12 | Historical idea record; adjacent README links it as the complete list |
| `handoffs/doktor-workspace/20261020T072914Z-69fdd611e5a7f348/reports/01-2026-10-20-cloud-idea-factory-20-games.md` | `62d4472b6b40986c99ff3c681a333a8cc1cd1f43` | 20 | Historical handoff snapshot, not an active registry |
| `proposals/site-kolobovdjp/plans/2026-10-23-personal-task-dashboard.md` | `1d4a262903318153aee025d9d723752178c22450` | 1 | Explicit proposal document; current proposal path preferred to its archived duplicate |

The archived dashboard artifact at `handoffs/doktor-workspace/20261023T080900Z-44b0c4a83ca116a9/artifacts/02-2026-10-23-personal-task-dashboard.md` (blob `9359eb4b172ab929e7a3f9c409341e2dbebbb242`) is deliberately not ingested a second time. No consolidated active idea registry was found in this investigation. Historical records do not imply ideas are approved, pending, or unimplemented today. Source names and `provenance` expose this distinction.

The dashboard proposal references a generic task queue and existing BOARD, not a literal `ideas.md`. No private contents were copied to Hub fixtures. Remote path/blob evidence is separate from the local parser proof; this is not a production UI or delivery test.

## Why the previous UI was empty

The previous Worker default loaded only two BOARD.md files. The parser only recognized tables with an `ID` header and IDs matching letters-hyphen-digits. The recorded idea lists use numbered tables (`#` with numeric IDs); the explicit Hub idea is prose. They were never loaded, and even loading them into the old parser returned no cards. That output did not mean the ideas did not exist.

## Implementation contract

`loadBoardSources(env, fetchImpl)` returns `{board}` or a configuration `{error:'board_unavailable'}`. The Worker must call it **after** owner authentication and may independently append telemetry. Reads use the existing read-only token; no token or raw error message appears in output. GitHub JSON content SHA is checked against the decoded Git blob before accepting it. Raw Markdown responses (including synthetic test fetches) get an equivalent computed Git blob SHA. Redirects are rejected, reads timeout, and both bytes and source count are bounded.

Defaults include two task boards and the three explicit records above. `BOARD_IDEA_PATHS` optionally replaces the idea list (comma-separated Markdown table sources); an empty string disables those records. Invalid configuration fails closed before network access. Partial source failure preserves successful cards and reports each failed source separately.

Cards preserve existing fields and add `key`, `owner`, `sourcePath`, `sourceRevision`, `sourceUrl`, `provenance`, `line`, `description`, `history`, `evidence`, `blockers`. `key` combines source path and ID, because numbered ideas legitimately repeat between files. `sourceRevision` is the Git blob SHA used for an answer target. `history` is empty when there is no actual event history; a current row is not fabricated into events. Evidence accepts HTTPS links only. Review has a distinct column.

Each source reports `available`, `empty`, `unsupported`, or `error`, counts, path, URL, blob revision, provenance. The frontend owns the transient `loading` state. `unsupported` explicitly distinguishes nonempty unrecognized content from an empty file. A source error is not an empty board.

## Validation and self-check

`node --test test/board-sources.test.js`: 7 tests, 7 passed, 0 failed, 0 skipped. Synthetic tests exercise numbered ideas, explicit prose adapter, detail links and blockers, unsupported/empty/error distinctions, partial failure, JSON blob integrity, token exclusion, invalid configuration, size limits and default deduplication.

The new parser was also run against the three local existing source records without printing or storing their contents: 12 + 20 + 1 cards. SHA-256 values respectively: `044ea1a5a2fef4ea66016bdaba5dc6898c882e8a9187b10da73744200149dd53`, `cd059f0d74bb9e2deca73b32ff18ef7078a8e9729078a2f48d10a4c81cd7d420`, `0b6444353c5567323c4c28839566cdcfd3a242a9c187b21ea5ae0a218672fb7e`.

- Solved assigned ingestion scope, reusing the parser and read-only GitHub access; no unrelated product code changed.
- Selection is explicit historical evidence, not inferred active task status; future format changes surface unsupported status.
- Missing, empty, malformed, repeated IDs across sources, partial failure and bad revisions have checks.
- Boundary: private GitHub content to authenticated API; owner gate remains the Worker integrator's responsibility. No credentials expanded.
- Existing board test expectations intentionally changed from folded review/progress counts to separate review counts. No assertion weakened.
- Production authenticated UI, live source fetch through deployed Worker and GitHub write delivery remain unverified here. Independent integration/browser QA is required.
