# GitHub secretary responses

Hub reads ACK and secretary answers from comments on an authenticated author's persisted, synced Issues receipt. This projection never writes GitHub or changes the saved delivery state. It does not imply that an external executor completed a task.

Activation requires both explicit server settings `HUB_RESPONSE_GITHUB_LOGIN` and `HUB_RESPONSE_GITHUB_ID`, matching the comment author's login and stable numeric ID, plus the existing `HUB_ISSUES_GITHUB_TOKEN`. Missing or invalid configuration leaves responses unknown. No frontend token, new privilege, endpoint, or timer is introduced.

The first line must be exactly `<!-- hub-response:<outbox-id>:ack -->` or `<!-- hub-response:<outbox-id>:result -->`, followed by a newline and plain text. Quoted markers, another message ID, another issue, another actor, and malformed evidence do not qualify. Multiple trusted comments with the same stage marker are a conflict; neither stage is inferred from delivery, labels, or the other stage. Results describe secretary processing, not external task completion.

GET outbox enriches only the current authenticated author's persisted page. Up to five newest distinct synced receipt issues are inspected per request, sharing a five-second deadline. Each issue allows two pages of at most 100 comments and 256 KiB per page; answer text is at most 8,000 characters. URLs are generated for the fixed repository; redirects are rejected. Incomplete pagination, overlapping pages, errors, and uninspected older issues remain explicitly unknown. The existing page cursor can select older saved messages. There is no background polling added by this reader.

`agentAck` and `agentResult` are null or `{text,url,createdAt,updatedAt,author}`. `responseStatus.status` is available, empty, not_configured, not_delivered, not_inspected, incomplete, conflict, or error. Returned text is rendered with DOM textContent and evidence links are restricted to the receipt issue's GitHub comments. A failed refresh removes stale response confirmations; session loss clears all private content and late responses cannot restore it.

Validation includes pure reader tests, an actual Worker with native SQLite and synthetic GitHub transport, and a real browser with synthetic API responses. These tests do not prove live GitHub consumer delivery. Production activation and end-to-end evidence remain separate integration checks.
