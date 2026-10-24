# Conference travel export

`GET /papers/conference-travel-export` is a read-only, privileged API returning
`{ "rows": [...] }`. It uses the same authorization as the lab-wide conference roster.
Ordinary member sessions cannot retrieve other people's travel plans.

Each row represents one recorded Going person at one conference key. Accepted-paper
attendance uses the existing conference roster rules; personal Going trips also appear,
including people without a paper. Multiple papers do not produce multiple beds.
Conference keys remain separate across venues and years. No conference-specific rules
or city assumptions are added.

The columns are `conference_key`, `conference`, `member_id`, `name`, `going_source`,
`trip_intent`, `needs_lodging`, `arrival_on`, and `departure_on`. A missing personal
lodging answer is `null`, rather than an inferred request or refusal. An explicit Going
trip can record either `true` or `false`. An undecided trip never creates a Going row
or a confirmed lodging request; if a paper separately records Going, that evidence
remains visible with `trip_intent: "undecided"` and unknown lodging.

For accommodation planning, filter by the exact conference key and count only rows
with `needs_lodging: true`. Confirm missing arrival/departure dates before booking.
Going headcount alone is not a bed count, and recorded requests are not bookings.
Free-text notes, funding details, credentials and contact addresses are excluded.

This endpoint does not modify or publish the protected PeopleList/PaperList sheet,
send Slack messages, alter attendance, or create reservations. Its backend must be
released through the existing reviewed Aurora process before production consumers
can use it; a Vercel frontend deployment alone does not release this endpoint.
