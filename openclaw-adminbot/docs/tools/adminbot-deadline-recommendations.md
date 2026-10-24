# Manual deadline recommendations

A signed-in active member can recommend a deadline to another active member. They may attach any number of papers linked to that recipient and a short reason. Preview shows the exact message and both participants; **Send in Slack** opens a conversation containing AdminBot, the recommender, and the recipient.

The deadline page shows recommended-member avatars to signed-in members after delivery succeeds. These are recommendations, not commitments to submit. The public deadline dataset contains no recommendation or roster data.

## Service contract

- `GET /deadline-recommendations` returns member names, avatars, Slack-link availability, paper titles and author IDs, and delivered recommendation relationships.
- `POST /deadline-recommendations/preview` accepts `deadline_id`, `recipient_member_id`, optional `paper_ids` (an array), and optional `reason` (up to 1,000 characters). It stores a pending `deadline.recommend` action and returns its ID, payload hash, participant names, and message. It sends nothing.
- `POST /deadline-recommendations/:id/send` accepts `payload_hash`. The authenticated author approves that exact preview. Another member, a service token, or an impersonated session cannot send it. Changed deadline data or Slack identities require a new preview.

The existing SQLite proposal ledger retains drafts, approvals, delivery outcomes, and audit events. The action requires a `recommender` approval, assigned only after checking its author against the authenticated member session. Delivery goes through the Slack connector with two distinct member identities. The bot needs the Slack permissions to open a multi-person conversation and post a message; missing credentials or rejected Slack calls surface as failures.

Repeated sends from the same recommender to the same recipient for the same deadline and set of papers share an execution key, including after a service restart. Changing the reason, repeating a paper ID, or reordering the selection does not send another copy. The connector also supplies a stable Slack message ID. A process failure after Slack accepts a message but before the local ledger records success can still require checking the conversation before retrying.

The API returns no-store responses. Reasons are escaped as text; link unfurls are disabled. Automated workshop matching and nudge eligibility are separate: these suggestions are initiated and explicitly sent by a person.

Exact dates in recommendation messages use the original source timezone and the offset applicable on the deadline date. Missing source timezones are stated beside UTC. Date-only announcements keep their calendar date without an invented closing time. A changed UTC cutoff invalidates an existing preview.

## Deployment and loading errors

Deploy the AdminBot service as well as the frontend before enabling recommendations. The member directory requires `GET /deadline-recommendations`; updating the Vercel frontend alone does not install that backend route. A missing directory endpoint shows one unavailable-service message. Retry reloads the failed member or paper search without submitting a recommendation. Optional recipient-summary failures do not block an independently successful member search.
