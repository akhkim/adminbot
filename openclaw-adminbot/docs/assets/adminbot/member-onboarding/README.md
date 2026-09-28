# Member onboarding review

The screenshots render the real member form and app stylesheet with synthetic values. Before is
main at `0df75c1729ba`; after is this change. They are component previews, not production screenshots.

| Recording feedback | Change / verification |
| --- | --- |
| External professor contact information | Existing name, email, WhatsApp and affiliation inputs retained; career stage separated from membership/access wording. |
| Role mixes career and relationship | New career-stage choices omit External Collaborator; existing values remain editable without being dropped. Membership/access remains separate. |
| Project entries in Meetings | Shared standing-meeting reader now lists Monday group and theme meetings only. Existing project invitations are not removed. Optional Slack groups travel with the approval-gated onboarding draft. |
| Automated contact should stay off | New-member contact opt-in remains unchecked. |
| Collaboration background | Notes explicitly labelled Background / reason for adding this person; elevator pitch remains separate. |
| Manual Member ID blocks creation | Admin-only create route generates a slug and year/numeric collision suffix. Duplicate addresses/manual IDs cannot overwrite an existing member. |
| Unclear approval state | Queue notice names Pending Actions, admin review, approval and execution. On-demand status distinguishes pending drafts from successful-send audit records; it never claims delivery/read confirmation. |
| Existing Member ID correction | Existing IDs remain immutable account/paper references. The editor explains this; display name is editable. A historical ID rename requires a separate reference migration. |
| Onboarding email confirmation | Admin-only status endpoint reads the existing send audit and proposal queue. Recorded successful sends, failed attempts and no draft are distinct. |
| Editor flips away | Background saves no longer reload the dashboard. Writes for one form are serialized; explicit save waits for earlier writes and keeps the form open on a rejected save. |
| Residence cities / affiliation | Native suggestions, exact alias normalization, and custom values retained in admin and self-profile forms. No bulk rewrite of existing records. |
| Joined month | New records default to the current month; explicit dates and existing records remain unchanged. |
| Calendar outcomes | New full members use the existing typed membership-change calendar workflow. Selected themes use the existing approved action path. Calendar failures are included alongside the guide-queue result. |
| Zurich Monday lunch | Existing location-observation/configured sweep/approval policy retained and explained. A residence text field alone is not confirmation of an invitation. |

Focused API, workflow, controller and UI tests use synthetic data. UI production build passes.
Repository-wide type checks have an existing red baseline; compare diagnostics with the same main
commit and dependency tree rather than claiming they are green.

After deployment, verify the demonstrated member's pending draft in Pending Actions, the actual
mailbox send/delivery outcome, Monday/theme calendar guest lists and the configured lunch sweep.
Those checks must not be replaced by a screenshot or a proposal's executed status. No production
member records, messages or invitations were changed while preparing this PR.
