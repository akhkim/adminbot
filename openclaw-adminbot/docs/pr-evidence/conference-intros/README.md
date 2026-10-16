# Conference intros: evidence

This PR has no UI change, so there are no before/after screenshots. What changes is a Slack group
DM. Below is the exact text the code produces for synthetic members, from
`buildConferenceIntroMessage` with the compiled deadline dataset and `today = 2026-10-15`:

```text
Hi Ada Lovelace, Bob Babbage and Cy Hopper -- you are all going to EMNLP 2026, so AdminBot is introducing you.
- Ada Lovelace and Bob Babbage both work on Multi-agent.
- Cy Hopper is also going (picked at random from the lab's attendees).

When: Sat, Oct 24, 2026 - Thu, Oct 29, 2026 (in 9 days)
Where: Budapest, Hungary - https://www.google.com/maps/search/?api=1&query=Budapest%2C%20Hungary
Event page: https://2026.emnlp.org/

Worth planning a coffee or a poster walk together.
```

No real Slack message was sent. The tests use a stub executor or a mocked `fetch`.
