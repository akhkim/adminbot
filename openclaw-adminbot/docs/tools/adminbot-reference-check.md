# Hallucinated reference check

Checks the references in Zhijing's OpenReview author submissions against published records, and
queues an approval-gated warning email to the authors for anything that cannot be matched.

This is a **tool**, not a schedule: it runs once, on command. It is stored as an OpenClaw cron job
with `enabled: false`, which never fires on its own but still executes on `cron run`, so it gets
run history, last error, and timeout handling like everything else. In the Control UI it appears
under **Tasks & Tools → Run on command**.

```bash
openclaw cron run "tool: hallucinated reference check"
```

## Runtime, and why the tool is scoped

Verification is rate limited, not compute bound: each reference walks arXiv, then Crossref, then
OpenAlex through one shared 1.1s limiter, stopping early only on a strong title match. A full sweep
of both venues (16 papers, ~65 references each) therefore costs roughly

    16 papers x 65 refs x 3 providers x 1.1s = ~57 minutes

which is exactly what a full run measured before it hit the job's 60 minute cap. The tool is
scoped to `--limit=2` (the 2 newest submissions per venue) so the button reliably finishes. Run a
full sweep from a shell, where nothing is timing it:

```bash
node scripts/adminbot-reference-check.mjs            # every paper, no cap
node scripts/adminbot-reference-check.mjs --limit=5  # or a bigger slice
```

The durable fix is a verdict cache: PaperMentor keys one per bib entry and skips repeat lookups, so
only new or changed references cost a request. That is not ported yet — note that this repo's
storage rule puts such a cache in SQLite, not the JSON sidecar PaperMentor uses.

Run it directly for a dry pass that queues nothing:

```bash
node scripts/adminbot-reference-check.mjs --no-propose --limit=1
```

## Pipeline

1. `adminbot-openreview.py author-submissions --venue <v> --download-dir <d>` lists every
   submission where Zhijing is an author and downloads its PDF.
2. `adminbot-pdf-references.py <pdf>` recovers the reference block.
3. The loopback vLLM transcribes that block into structured entries, temperature zero under a
   strict JSON schema.
4. `scripts/lib/reference-verifier.mjs` decides a verdict per entry.
5. Papers with critical findings become one `email.send` proposal each, cc'ing Zhijing, in
   **Pending Actions**. Nothing is sent until a human approves it.

## Venue quirks that the fetch step handles

- **ARR** submissions carry a `pdf` field and download directly.
- **EMNLP 2026 hosts no PDFs.** It is a commitment venue: each note carries only a `paper_link` to
  the ARR forum holding the real paper, which the fetch follows. `client.get_attachment(id, "pdf")`
  404s on both venues; `client.get_pdf(note.id)` is the working call.
- Withdrawn and desk-rejected submissions are listed but not checked — those authors are not
  revising. `--include-withdrawn` overrides.

## Verdicts

Ported unchanged from PaperMentor's `CitationVerifier.mjs`
(`https://github.com/jiarui-liu/overleaf`): `verified`, `fabricated`, `mismatch`, `unverified`,
`doi_not_found`, `doi_mismatch`, `no_title`. Title similarity is strong at 0.85 and candidate at
0.70; year tolerance is 1 clean, 3 warning.

Only `fabricated`, `doi_not_found`, `doi_mismatch`, and critical `mismatch` findings trigger an
email. Everything else is reported and left alone.

## Why the provider order is what it is

`SEMANTIC_SCHOLAR_API_KEY` is optional but **strongly recommended** — PaperMentor's thresholds were
tuned against Semantic Scholar, and it is the only provider whose coverage makes "no result" mean
anything.

Without a key the tool queries arXiv, then Crossref, then OpenAlex, and unions the candidates.
arXiv leads because the reference population here is NLP/ML and Crossref's ACL Anthology deposits
are metadata-poor: `10.18653/v1/N19-1423` (the BERT paper) resolves in Crossref with an _empty_
title and is missing from OpenAlex entirely. A Crossref-led search reported it as fabricated.

## Precision without a key

Everything in this section switches itself off the moment `SEMANTIC_SCHOLAR_API_KEY` is set, which
restores PaperMentor's original behaviour. Each rule below was added because it produced a
false positive on a real submission, not on principle:

| Situation                                            | With a key   | Without one                    |
| ---------------------------------------------------- | ------------ | ------------------------------ |
| Lookup failed outright                               | `unverified` | `unverified`                   |
| No candidate returned                                | `fabricated` | `unverified`                   |
| Weak best match (< 0.70)                             | `fabricated` | `unverified`                   |
| Borderline title (0.70–0.85) **and** fields disagree | `mismatch`   | `unverified` (wrong candidate) |
| Author disagrees on a verbatim (≥ 0.95) title        | critical     | warning                        |
| Year disagrees, no DOI anchoring the record          | critical     | warning                        |
| DOI does not resolve, or resolves elsewhere          | critical     | critical                       |

The reasoning is the same each time: the free indexes are incomplete _and_ their records are often
wrong, so a disagreement is at least as likely to be a bad record as a bad citation. The measured
cases were Ostrom's "Governing the Commons" (verbatim title, Crossref listing its first author as
"field"), Hayek's "Individualism and Economic Order" (1980 reprint vs a 1996 record), and Turner's
1982 "The determination of collective behaviour" (matched to an unrelated 2024 paper).

The practical consequence: **without a key, only DOI-level contradictions produce a warning email.**
Those are high precision — a DOI either resolves to the cited paper or it does not. Everything else
still appears in the run report for a human to read. Adding the key turns the fuller set back on.

## Configuration

| Variable                          | Default                                                | Purpose                                                                    |
| --------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `SEMANTIC_SCHOLAR_API_KEY`        | unset                                                  | Enables the trusted provider and the `fabricated` verdict on empty results |
| `ADMINBOT_REFERENCE_CHECK_VENUES` | `EMNLP/2026/Conference,aclweb.org/ACL/ARR/2026/August` | Comma-separated venue ids                                                  |
| `ADMINBOT_ZHIJING_EMAIL`          | `zjin@cs.toronto.edu`                                  | Address cc'd on every warning                                              |
| `ADMINBOT_REFERENCE_MAX_ENTRIES`  | `200`                                                  | Per-paper entry cap                                                        |
| `ADMINBOT_REFERENCE_CHECK_JSON`   | unset                                                  | Write the full result set to this path                                     |

`OPENREVIEW_USERNAME`/`OPENREVIEW_PASSWORD`, `ADMINBOT_LOCAL_BASE_URL`/`ADMINBOT_LOCAL_MODEL`/
`VLLM_API_KEY`, and `ADMINBOT_SERVICE_TOKEN` come from the usual env file.
