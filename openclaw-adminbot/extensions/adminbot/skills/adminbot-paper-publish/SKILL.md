---
name: adminbot-paper-publish
description: Prepare AdminBot PaperPublish workflows for paper release, metadata, venue submission, author approvals, public links, and publication checklists. Use for paper publishing preparation or submission proposals.
---

# AdminBot PaperPublish

Use this skill for paper publication preparation and submission.

## Pipeline Record

Every active paper should have an AdminBot paper record. Use
`adminbot_upsert_paper` to maintain:

- authors and mentor,
- current step,
- Brainstorming Docs link,
- Overleaf view/edit links,
- submission link/status,
- Google Drive paper PDF link,
- arXiv polish checks,
- Twitter and LinkedIn draft links,
- Google Slides deck link,
- poster link.

Use `adminbot_list_papers` before creating a new record when you need the
current active paper list or want to avoid duplicates.

The standard process is:

1. `brainstorming_docs`
2. `overleaf_writing`
3. `submission`
4. `google_drive_pdf`
5. `arxiv_polish`
6. `social_posts`
7. `slide_making`
8. `poster_making`

For `arxiv_polish`, track paper mentor review, affiliation check, and GitHub
link check in `checks`.

For `overleaf_writing` or user-prompted paper source edits, use
`adminbot_prepare_overleaf_paper_edit` rather than a generic proposal. Provide
the paper id when the Overleaf edit link is already in the project record; only
pass an explicit `overleafEditUrl` when the record is missing or incomplete.
Set `mode="affiliation_check"` for affiliation cleanup. Do not guess exact
institutional wording: unresolved authors, missing member records, Zhijing's
paper-specific affiliations, EuroSafeAI eligibility, and company-affiliation
questions should stay as confirmation items in the proposal until the user or
student confirms them.

For `social_posts`, authors draft Twitter first. AdminBot can translate/adapt
that into LinkedIn style and include likely author/lab/topic tags, but public
posting remains a separate T4 proposal.

For `poster_making`, use the top six meaningful slides from the Google Slides
deck as the starting point, then propose the rearrangement plan before any
external export/upload.

## Nudges

When waiting on authors, set `reminder.status="waiting_on_authors"` and record
`last_author_dm_at` after the direct message requesting the current step. Use
`adminbot_list_papers` to show each paper timeline, then `adminbot_list_paper_nudges` to find due reminders.

If authors have not replied after three business days, AdminBot should produce
a head-professor escalation nudge. In Andrew's lab, set
`head_professor_member_id` to Zhijing's lab-member id. Use `adminbot_propose_paper_nudge` to create the approval-gated Slack task that asks Zhijing to nudge the authors directly.
Use `adminbot_get_settings` or `adminbot_update_settings` when the lab wants to
change the default escalation window or the default head professor id.

## Preparation

Use `adminbot_propose_action` with `type="paper_publish.prepare"` to track:

- title, authors, affiliations, and author order,
- venue or release target,
- files and version ids,
- abstract, keywords, links, and license,
- author approval status,
- missing checklist items.

## Submission

Submission is T4. Use `adminbot_propose_action` with
`type="paper_publish.submit"` only after the user confirms venue, final files,
metadata, author approvals, and timing.

Include exact file ids or hashes and an idempotency key tied to venue, paper id,
and version.
