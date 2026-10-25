# Dashboard-first validation

The homepage reuses the existing board template for accounts that already pass the board authorization gate. Other signed-in accounts retain their application catalog. The explicit catalog and legacy board URLs remain available. No new permission, credential, storage, delivery adapter or background task is introduced.

## Checks performed

- Full Node regression suite: 244 passed, including real SQLite and signed WebAuthn tests.
- Existing browser acceptance suite using the actual Worker and SQLite: 22 passed. GitHub responses are synthetic; this is not production delivery evidence.
- Existing recovery browser suite: 3 passed, covering persisted pending records and reconciliation without duplicate sends.
- Independent dashboard browser suite: all checks passed at 320, 390, 768 and 1280 pixels. It covers root and legacy board URLs, catalog/chat/download navigation, entitlement filtering, equal catalog card heights, search, modal keyboard/focus/Back behavior, and delayed board/outbox responses after logout.
- Existing board browser contract passed after its fixtures were updated to distinguish session reads from outbox reads.
- CSP, the 36-entry release catalog, public artifact allowlist, Pages redirects and the Worker dry-run bundle passed. Initial sandbox temporary-directory failures were rerun successfully with local test access.
- Independent code review found no blocking findings. A real 320-pixel overflow found during browser QA was corrected with narrow grid/flex sizing constraints and then independently retested.

Shared logout synchronously clears board and chat data before awaiting the logout request. Late successful responses cannot restore private UI. The light theme is also used when the operating system requests dark mode; login and PWA metadata match that deliberate design choice.

## Screenshots

All screenshots use synthetic data. Both the QA agent and integrator inspected the resulting layout; they do not establish authenticated production behavior.

| Width | Dashboard | Catalog |
| --- | --- | --- |
| 320 | [Dashboard](../../artifacts/hub/dashboard-first-320.png) | [Catalog](../../artifacts/hub/dashboard-first-catalog-320.png) |
| 390 | [Dashboard](../../artifacts/hub/dashboard-first-390.png) | [Catalog](../../artifacts/hub/dashboard-first-catalog-390.png) |
| 768 | [Dashboard](../../artifacts/hub/dashboard-first-768.png) | [Catalog](../../artifacts/hub/dashboard-first-catalog-768.png) |
| 1280 | [Dashboard](../../artifacts/hub/dashboard-first-1280.png) | [Catalog](../../artifacts/hub/dashboard-first-catalog-1280.png) |

## Remaining boundary

This is a separate UI draft. Merge and production deployment require their own approval. Source-loading and delivery availability must be diagnosed independently; a successful UI test or a synthetic receipt does not resolve an upstream production error.
