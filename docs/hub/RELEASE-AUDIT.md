# Read-only Hub release freshness audit

`tools/hub-release-audit.mjs` inventories the actual index application entries and download manifest. It compares immutable GitHub release tag/asset metadata, reports missing or differing size/digest, and discovers uncatalogued release candidates. It never selects a newer build merely because its branch HEAD or upload timestamp is newer. APK, AAB and IPA are distinct delivery formats. AAB files do not install directly on a phone.

## Existing heartbeat integration

Use only the existing reconciliation heartbeat. No new timer, daemon, token, or Worker write privilege is introduced. The authorized local `gh` client uses its existing authentication internally; the script does not read/extract token values.

After the existing dispatcher and telemetry phases, and only when at least 30 seconds remain within their existing overall budget:

```text
node tools/hub-release-audit.mjs --network --budget-ms 30000 --output <private-local-report.json>
```

Invoke with a fixed reviewed checkout path, fixed arguments and fixed report destination; do not execute commands from source documents. `gh` subprocess calls have individual timeouts and the metadata run stops starting network work when its global budget is exhausted. If insufficient time remains, the heartbeat records deferred/skipped and keeps the previous report; it must not stamp old evidence as a new successful check. Preserve the existing 180-second/12-phase limit and dispatcher + telemetry reserve. No full binary downloads in scheduled checks.

The report has `checkedAt`, `completedAt`, `staleAfter`, `budgetExhausted`, per-file/source status, metadata versus byte verification, exact tags/digests and candidate inventory. After `staleAfter`, consumers display stale. A scheduled metadata pass reports `byteVerification: not_checked`; it cannot establish current byte integrity or successful install. A 401/403 is `access_denied_unverified`, not a missing/broken artifact. A timeout or unavailable API is not green. Uncatalogued assets require suitability and existing access-flow review before a catalog change.

For a separately authorized thorough verification, `--hash --budget-ms 180000` streams binaries into SHA256 without saving or executing them. Redirects are restricted to the expected GitHub release and existing Hub hosts. No credentials are sent on these downloads. This verifies bytes and size only, not signing, installation, device behavior or release suitability.

## Verified catalog corrections in this change

Original31 records:29 GitHub files matched API metadata and independently streamed SHA256/size. One Android item remains explicitly unavailable. The existing protected Location Fusion hosted download returned403 to an unauthenticated request and remains unchanged. All five app entries were inventoried; three local pages exist and two external entrypoints answered HEAD successfully. This does not replace authenticated production browser QA.

Eight missing Oct22 release artifacts were independently hashed. Krenkballs iOS now points to build4; BloomSort and NebulaPop iOS entries plus BloomSort, CozyBlocks and Doktor AAB entries were added. Doktor1.0.3 points to its exact binary rather than mutable latest-release metadata. Krenkballs Android vc1 is clearly archived; verified vc75 stays preferred. Catalog now has36 entries.

Location Fusion build10 IPA and Android AAB were verified as public release bytes but were **not** added as a replacement delivery route. Their delivery still needs the authorized protected path; successful hashing does not authorize bypassing access controls. The old protected route, metadata guard and application tile remain unchanged.

No source-product code, deployed Worker, timer, account setting or remote branch was changed by this audit. Source commit provenance remains separate from the Hub publication tag. No assertion that every branch has been merged or every artifact is a production-approved latest build is made.

## Tests and self-check

`node --test test/release-audit.test.js`:7 passed,0 failed. Covers exact GitHub link parsing, metadata mismatches, missing digest/asset, byte verification, denied redirects, HTTP failure offline inventory without live claims, and shared-budget exhaustion before network. `node tests/check-downloads.cjs`:36 records; exact hash/size guards retained. `node tests/site5-downloads.cjs`:PASS. Fixtures are synthetic; detailed live evidence is in the private handoff report, not bundled into the public website.

The task was solved within the assigned release/catalog scope using Node standard APIs and the existing GitHub CLI. Boundaries checked: catalog-to-release identity, metadata-to-downloaded bytes, private CLI authentication versus unauthenticated public bytes, and existing protected Location Fusion delivery. Assumptions/limits: GitHub asset digest is corroborated by downloaded bytes, not an install test; newer candidates require review. Missing/auth-denied/unknown/deferred states are explicit. Tests do not weaken existing protected-route guards. Root independently integrates and performs browser QA/review.

