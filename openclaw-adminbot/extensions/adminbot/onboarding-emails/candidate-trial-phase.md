---
group: candidate / interview result -- trial phase begins
pipeline: candidate -> trial
maps_to: privilege_level = trial
source: supplied verbatim by the lab
placeholders: {first_name}, {drive_folder_link}, {slack_connect_link}
---

Subject: `Next Steps: Trial Phase with Jinesis AI Research Lab`

```text
Hi {first_name},

Thank you for taking the time to interview with Jinesis AI Research Lab. We enjoyed learning more about your background, previous projects, and research interests.

We are excited to invite you to the trial phase of the lab. During this period, you will work on a research or engineering task over the next three weeks. This will give both you and the team an opportunity to explore how your skills, working style, and research interests align with the lab.

You will receive further details about the task and expectations from your interview lead. You will also be given access to Slack so you can communicate with the team and ask questions throughout the trial period: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: https://join.slack.com/t/jinesis/shared_invite/zt-3d5p5t0nl-dsxvIZW3DJuC0b5lMkk3Vg

This will be your google drive workspace, {drive_folder_link}. This will be where you will be placing your CV, transcript, and your progress update for the project you are working on.

We look forward to seeing your work and learning more about your contributions.

Best regards,
Jinesis AI Research Lab
```

**Notes**

- This is the email that needs the Drive folder provisioned at send time
  (`Zhijing-<Name>`, link-editable). It replaces the earlier `trial.md` draft.
- The Slack Connect link is now carried inline, so the reader is not told about access
  they have not been given.
