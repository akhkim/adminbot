---
name: adminbot-join-form-triage
description: Classify and filter join-the-lab Google Form responses for AdminBot. Use when reading application forms, ranking or labeling applicants, extracting review questions, or deciding whether a candidate needs human review before any accept or decline proposal.
---

# AdminBot Join Form Triage

Use this skill for observational classification of form responses.

## Flow

1. Confirm the form response id and applicant name if available.
2. Extract only the fields needed for the rubric.
3. Use `adminbot_classify_join_form_response` with the raw answer map and
   rubric summary.
4. Return the class, confidence, evidence pointers, and review questions.
5. If a decision is requested, hand the summary to an admin. Accepting or
   declining a candidate is not something AdminBot can carry out: there is no
   connector behind it, so a proposal would sit approved and unexecutable.

## Classification Guidance

- Keep labels descriptive and reviewable, such as `strong-match`,
  `needs-review`, `missing-information`, or `not-current-fit`.
- Flag missing availability, unclear research interest, mismatched expectations,
  and possible duplicate submissions.
- Do not infer sensitive attributes or use protected characteristics.
- Do not treat classification as permission to contact, accept, or decline.
