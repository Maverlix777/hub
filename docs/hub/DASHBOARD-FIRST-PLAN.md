# Dashboard-first homepage plan

The approved direction makes the existing working board the homepage for accounts already authorized to see it. Other signed-in accounts retain their permitted application catalog. The catalog remains at `/hub/index.html`; the legacy board URL continues to use the same board template. This UI work is a separate draft from the incident diagnostic patch and does not authorize merge or deployment.

The shared light header links to the board, applications, Claude API and downloads, with account and logout controls. Existing session and entitlement checks determine available navigation. The dashboard keeps owner questions prominent, then tasks, ideas and observed team activity, followed by the existing message queue. Source errors, delivery stages and unavailable evidence remain honest.

The catalog uses aligned cards with concise descriptions and a visible open affordance. It has three columns on desktop, two on tablet and one on phones. Chat and downloads adopt the same header and light palette; their data, API-key behavior, forms and download registry remain unchanged.

Implementation ownership: the UI stream owns public page markup, shared CSS, board presentation, narrow reuse of the existing hub.js session/header code, and this plan. A separate routing stream owns Worker route selection and its authorization tests. Independent QA owns actual Worker/browser integration, visual inspection and screenshots at 320, 390, 768 and 1280 pixels.

The board template uses absolute `/hub/` asset and navigation URLs so it renders identically at the homepage and legacy board route. No new framework, storage, credential, permission or executor behavior is introduced. Session invalidation and logout must clear private data and remain final against delayed successful responses.

Acceptance checks cover CSP, both board entry points, all navigation links under `/hub/`, catalog entitlement filtering, logout including late responses, chat key persistence, download links, mobile overflow, equal card heights, dialog focus/Escape/Back and the existing outbox tests. Screenshots establish layout only; synthetic APIs do not establish production authentication or GitHub delivery.
