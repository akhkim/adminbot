# AdminBot contributor credit

Generate evidence for the `adminbot` citation's author field in the linked Overleaf
project. This does not change the paper byline, other references, or live AdminBot data.

Review distinct major product capabilities from merged PR bodies and diffs. Do not
count formatting, dependencies, routine fixes, or several PRs for the same feature
as separate improvements. Give each reviewed feature a stable ID. Verify display
names against the contributor's profile or the existing citation.

Create a JSON array of `{login, name, features: [{id, prs: [18]}]}`. Include all PRs
supporting each feature. Only reviewed people are evaluated; absence from the output
is not evidence that an unreviewed person is ineligible.

```sh
node scripts/adminbot-contributor-credit.mjs reviewed-features.json > credit.json
node --test scripts/adminbot-contributor-credit.test.mjs
```

The script fetches merged history with the existing authenticated `gh` CLI. It
rejects missing/unmerged PRs or PRs authored by a different account, deduplicates
feature IDs, and outputs people with at least three reviewed features plus an
alphabetical BibTeX author field. Alphabetical order uses the verified full name.
No remote Overleaf write occurs and no credential is stored.

Before applying the output to `refs.bib`, reconcile it with existing credited
names and the agreed first/senior-author ordering. Never replace the entire
bibliography or remove existing authors merely because they were not reviewed.
Preserve the citation key, title, year and all other fields. Recompile and inspect
the resulting AdminBot reference after an authorized targeted edit.
