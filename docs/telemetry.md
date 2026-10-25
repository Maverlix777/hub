# Read-only local telemetry in the existing board

The board keeps its existing session and `BOARD_OWNER_USERNAME` checks. Telemetry is fetched only after those checks, and only after the manual board loads successfully. This change adds no endpoint, credential, uploader, database table, scheduler or deployment. It does not change production configuration.

The optional `BOARD_TELEMETRY_PATH` selects one JSON artifact in the **same** `BOARD_REPO` already read by the board, using its existing server-side `BOARD_GITHUB_TOKEN`. Leave the variable unset to keep the reader disabled. An example path is `telemetry/current.json`; it is not a file supplied by this repository. Never put real telemetry in the public static assets or this public repository. Enabling a real private artifact source and deploying the reviewed code are separate owner actions; no additional token or grant is assumed.

The input is the local-manager-telemetry schema version 1 envelope from the producer in the separate telemetry-adapter PR #710. The synthetic fixture in `test/fixtures/telemetry-v1.synthetic.json` was generated using that producer with invented inputs only. The reader projects a closed set of fields instead of forwarding the envelope. It discards raw prompts, responses, contexts, source paths, proof bodies, arbitrary extra fields and producer totals. It recomputes throughput from valid measured token counts and durations. This is a contract dependency, not a live data connection.

`GET /hub/api/board` retains `cards`, `counts` and `unmappedCount` and adds `telemetry`. The manual board's owners, status, counts and Done column remain unchanged. The existing UI renders a separate **Снежанна · локальная активность** section with text nodes. Снежанна is the display name of the local secretary, not a new worker instance. Producer `result_verified` becomes `result_reported` with `producer_claimed_verified: true`: the Hub does not independently verify local artifacts. Unknown or `done` states never become task completion. Missing task identity stays unknown even if a proof object asserts an identity.

Missing, malformed, failed, future or more than 15-minute-old exports are `unknown`. Individual stale event or measurement times also become unknown; missing numeric measurements stay null, not zero. These are timestamped snapshots loaded with the board, not live GPU sampling. Refresh the board to fetch a new snapshot. Historical metrics older than the freshness window are intentionally not displayed as current measurements.

Identical event IDs and model-run identities deduplicate; conflicting projected facts reject the export. Run identity is explicit `run_id`, or `model` plus `created_at` when the producer did not supply a run ID. Unknown identity fails closed. Reads are limited to 256 KiB, 2,000 events, 100 model results and 16 GPU samples. This consumer's 256 KiB limit is deliberately smaller than the producer's 4 MiB output limit: larger exports are unknown, not truncated or silently accepted. The GitHub request uses a five-second abort signal, refuses redirects and accepts only a validated relative JSON path under the existing repository. Errors expose a bounded status, never upstream response details or credentials.

## Concurrency and preservation

The Worker performs GET requests only and never writes the source artifact, manual board or local state. Concurrent owner edits cannot be overwritten by this reader; each request builds a separate response. Consistency of multiple source files across revisions is not transactional. The producer/publisher must enforce its own single-writer or compare-and-swap contract. This reader neither claims nor substitutes for that guarantee, and no publication path is implemented here.

## Validation

Run `npm test`, `node tests/check-csp.cjs`, `node tests/check-downloads.cjs`, `python3 tests/check-site-artifact.py` and `python3 tests/check-pages-redirect.py`. Tests use synthetic data and mocked upstream HTTP only. The UI test executes the real board script against a small DOM test double; it is not browser QA or a deployed owner-session test.

Do not deploy the public main Worker over a private production build. Follow the existing private-baseline deployment gates in `CLAUDE.md` and `CLOUDFLARE.md`.
