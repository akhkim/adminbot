# OpenReview identity on paper cards

The existing hourly paper-evidence pass reads the exact OpenReview submission linked in each active
paper's submission slot. It uses the public API anonymously. Successful reads store
the public title and the optional ARR `previous_url` submission ID in the existing SQLite
slot table. Existing verified slots without metadata are backfilled on the next pass;
successful metadata is refreshed after 24 hours.

Both the paper card and the flat paper form show:

- The linked OpenReview title, flagging differences from the AdminBot title after ignoring
  case, punctuation, and spacing. This is a prompt to check the title or link, not an
  accusation of an incorrect submission.
- “Resubmission reported by OpenReview” and a previous-submission link only when the
  public record explicitly provides one. Otherwise history is **unknown**.
- Possible earlier versions discovered by comparing public abstract text with earlier
  submissions from shared public OpenReview author IDs. Different titles are allowed.
  Each candidate shows the two abstract excerpts, shared author IDs, date, and phrase
  overlap. This is evidence for a person to review, not confirmation of a resubmission.
- Search coverage and the last successful check date. A private or unavailable record
  is not invalidated.

Changing or clearing a submission URL removes its old verification metadata. A slow
response cannot overwrite a link edited while the request was outstanding. No papers
are renamed, merged, or matched by fuzzy title search.

The content search reads actual abstracts, not PDFs. It compares three-word phrases using
Dice overlap and requires at least 65% overlap, a shared public author ID, an earlier
record date, and at least 40 words / 30 distinct phrases in each abstract. These are
conservative heuristics, not a calibrated confidence score. Substantially rewritten
abstracts can be missed; related papers reusing text can be false positives.

Search is bounded to the first three public author IDs and 100 notes each; results are
deduplicated and the best three candidates are shown. Truncated or partly failed searches
are labeled incomplete. Missing public authors, abstracts, or dates prevent comparison.
No match never means “not a resubmission.” It does not use reviewer credentials.
The first read happens when the existing `/papers/evidence/verify/run` job runs; this
requires deploying the backend as well as the UI.

API semantics: [OpenReview note IDs and forums](https://docs.openreview.net/getting-started/objects-in-openreview/introduction-to-notes).
Resubmission evidence: [ARR's Previous URL field](https://aclrollingreview.org/reviewerguidelines#how-to-review-resubmissions).

The screenshots below render the real flat-paper component with production styles and
synthetic data. They are local component previews, not screenshots of live lab records.

![Desktop paper form](../assets/adminbot/openreview-identity/desktop.png)
![Phone paper form](../assets/adminbot/openreview-identity/mobile.png)
