---
group: external_collaborator / coauthor_minor
lab_name: External Junior Collaborator -- Onboarding + Expectations
expected_commitment: 5-10 h/week
matrix_grants: spreadsheet_full_details, spreadsheet_basic, welcome_linkedin_twitter, welcome_newsletter, slack_connect_friends_channel, active_channels, discussion_channel, project_channel, project_drive_folder, newcomer_drive_practice, google_file_practice_guide (yes_separate), what_to_expect_stories (yes_separate), rec_letter_button (case_by_case), city_dinner_invite
separate_followups: google_file_practice_guide, what_to_expect_stories -> Separate Practices Doc email
deferred: project_channel -- #proj-* are often private, so the bot cannot see or invite
source: supplied verbatim by the lab
placeholders: {first_name}, {project_or_context}, {meeting_cadence}, {contact_name}, {discussion_channel}, {drive_folder_link}, {next_steps}
enriched: |
  The lab text was extended with the matrix grants it did not cover: the Slack channels,
  the Drive folder and its conventions, the follow welcomes, and the dinner invites.
  Internal-only rows stay out, rec letters stay silent (case_by_case), and the two
  yes_separate practice docs remain a separate email.
---

Subject: (none supplied -- suggest `Welcome aboard: {project_or_context}`)

```text
Hi {first_name},

Welcome aboard, we are excited to work with you on {project_or_context}!

How we work: the project meets {meeting_cadence}, and your main point of contact is {contact_name}. We coordinate on Slack rather than email wherever possible; you will receive an invitation to the relevant channel(s) shortly. Progress updates are shared in the project channel, so a short weekly note on what you did, what is next, and any blockers is the norm even in slow weeks.

Two things we ask of everyone: flag blockers early (a blocked week is normal, a silent blocked month is not), and let us know in advance about exams, internships, or travel so we can plan around them.

Where things live on Slack: #jinesis-with-friends-and-collaborators for our wider circle, #jinesis-active and #random-active for the lab's day-to-day, and {discussion_channel} for the broader topic your work sits in. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: https://join.slack.com/t/jinesis/shared_invite/zt-3d5p5t0nl-dsxvIZW3DJuC0b5lMkk3Vg

Your project Google Drive folder is {drive_folder_link}. A few conventions save a lot of friction later: one long doc per topic rather than several tabs, kept Pageless, filenames prefixed with the date (yyyymmdd), and a flat folder so sorting by last-modified stays useful. I will send our Google file practices and what to expect working with us as a separate short note.

If you would like to follow the lab more widely, there is our newsletter, https://www.linkedin.com/company/jinesis-lab/ and https://x.com/JinesisLab. You are also welcome at our city dinners and team building events.

Next steps: {next_steps}.

Best,
AdminBot
```
