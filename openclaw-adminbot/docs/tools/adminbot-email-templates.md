# Email template drift check

The onboarding and collaborator emails are written and reviewed in a Google Doc, and shipped from
`extensions/adminbot/src/workflows/onboarding/emails.ts`. Those are two copies of the same prose,
and keeping them in step used to be a manual transcription every time somebody edited a paragraph —
the kind of job that gets done carefully twice and then not at all.

`scripts/adminbot-email-templates-sync.ts` reads the doc and reports every place the two disagree.

```bash
pnpm adminbot:templates:check              # fetch the doc, print the diff, exit 1 on drift
pnpm adminbot:templates:check -- --json    # same, machine-readable
pnpm adminbot:templates:check -- --from saved-documents-get.json
```

It runs weekly from cron (`adminbot-email-templates`, Mondays 08:30) and exits non-zero on any
difference, so drift shows up as a red run in the Control UI's Cron tab with the diff in its output.
That is the whole notification: nobody is emailed about it.

## It never writes emails.ts

Deliberately. Generating the shipped copy from the doc is a short step from here and is not taken,
because the doc is a working document rather than a source file. When this was written it carried:

- an approved template reading *"your application to usGoogle Form response"* — a botched edit;
- `([LINK])` where the code carries `{application_form_link}`;
- a section marked `[Needs work]` with no subject line at all.

An unattended writer would have shipped the first two to applicants. A literal placeholder reaching
a recipient is the one failure the header of `emails.ts` opens by warning about, so the tool prints
a diff and a person makes the edit.

## How a template is identified

`config/email-template-map.json` ties each doc section to a template id. A section is keyed by its
**slug line** when it has one — three do, e.g. `top1-30min-zhijing` — and otherwise by its nearest
heading.

Slugs are much better: keyed by heading, renaming a heading turns the section into an unmapped one
that somebody has to clear. Worth asking for a slug line on every template in the doc.

Sections and templates with no counterpart are listed in the map's `docOnly` and `codeOnly` blocks,
each with the reason it is one — the PaperFlow co-author mails are sent from the paper thread rather
than by this sender, acquaintances get no onboarding mail at all, and so on. Anything on neither
list is reported as drift rather than skipped, so a new template cannot slip in unwatched.

## The token map

The doc spells out what the code fills in: `akim@cs.toronto.edu` where the code has
`{contact_emails}`, `[PAPER_SHORT_TITLE]` where it has `{paper_title}`. The map's `tokens` block
records those pairs, and the checker applies them before comparing so a token is not reported as
drift every run. Longest literal wins, so a short one cannot eat a longer one it prefixes.

A `[BRACKET]` that survives the token map is reported on its own: it is a placeholder the code was
never taught about, which is exactly the shape of a half-finished doc edit.

## What it needs

The doc read is `gog docs cat --raw` — the same call and the same account the guidebook sync uses
(`extensions/adminbot/src/guidebook/sync.ts`), so it needs no credential of its own. `GOG_ACCOUNT`
must be set; the cron wrapper sources the AdminBot env file and says so if it is missing.

`--from` takes a saved `documents.get` payload instead, which is how the parser is exercised without
network or credentials.

## Related

- [Onboarding guide sender](/tools/adminbot-onboarding) — what actually sends these templates
- [Guidebook sync](/tools/adminbot-guidebook) — the other consumer of the same Docs plumbing
