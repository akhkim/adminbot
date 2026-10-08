# OpenReview notifications to tweets

One command reads an OpenReview notification export and produces tweet drafts.
Python 3.10+; optional PNG output requires Pillow. No network calls or automatic posting.

```sh
python3 /Users/felixhu/src/openreview-notifications/parse_notifications.py \
  2026-09-01 neurips --input ~/Downloads/openreview-notifications.json
```

`--input` is required. Add `--template 3` to choose one of ten templates; otherwise
one template is chosen randomly for the run. Each conference/year gets one
announcement, with main-conference, special-track, and workshop papers clearly
labeled in a single numbered list. Templates vary from brief announcements to
warmer congratulations, with light emoji and optional closings. All end with
the configured institution handles.

The same command also supports:

- `--format json`: structured announcements with `text`, paper titles, track labels, and source IDs.
- `--format notifications`: original acceptance notifications for inspection.
- `--all-notifications`: diagnostic JSON of all date/conference matches,
  bypassing acceptance detection and overriding `--format`.

To also save readable PNGs of the paper list, add `--images ./images`.
Each image includes full titles and track labels, without OpenReview links.
Image height fits the content with a small bottom margin.
Long lists span numbered images; tweet text still goes to stdout, and saved paths
go to stderr. This option works with text or JSON tweet output. Rerunning replaces
matching PNG filenames; the folder may still contain images from earlier runs.

Install the optional dependency in a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install Pillow
.venv/bin/python parse_notifications.py 2026-09-01 neurips \
  --input ~/Downloads/openreview-notifications.json --images ./images
```

All command-line behavior lives in `parse_notifications.py`.

## Code layout

```text
parse_notifications.py           Load → filter → verify → format → output
openreview_notifications/
    filters.py                   Date and venue selection; final venue check
    acceptance.py                Named acceptance rules and evidence evaluation
    messages.py                  Message cleanup, paper titles, OpenReview links
    tweets.py                    Deduplication, ten templates, announcement formatting
    images.py                    Optional PNG rendering and pagination
tests/                           Selection, formatting, and command regression tests
```

## Selection rules

The minimum date is exclusive: `cdate > cutoff`. A date alone means midnight UTC;
ISO timestamps must include a timezone. `cdate` is notification creation time,
not necessarily the original acceptance date.

Conference selection first reads the parent venue before the year in `domain`.
Workshops and tracks belong to that parent conference. Missing/generic domains
fall back to structured invitation, signature, and referrer metadata, then sender
and subject-header hints. Paper titles and bodies do not establish the venue.
ACL, EACL, and ACL Rolling Review remain distinct.

Acceptance requires an explicit decision or confirmation about the recipient's
paper. The named rules in `acceptance.py` cover labeled decisions, direct
acceptance statements, and congratulations/reminders. Known paper titles are
masked during prose matching. Quoted/forwarded messages, proposals, reviewer
recommendations, statistics, conditional decisions, and conflicts do not count.
Hypothetical instructions do not override a separate explicit final decision.

After selection, **every structured venue field must agree** with the requested
conference. Conflicts or unverifiable venues stop the entire command before
output, with the affected notification IDs on stderr. This check applies to all
output modes. Years get separate announcements; tracks are combined and labeled.

## Drafts and limitations

Within each conference/year/track, papers are deduplicated by forum ID, or by title when a link
is missing. Distinct known forum IDs remain separate. Findings, workshops, and
special tracks are labeled within the announcement. Drafts use actual titles without OpenReview links; they do not invent summaries,
authors, or presentation formats. Links remain in JSON metadata and are used for
deduplication.

An acceptance reminder counts even without the original decision. If its paper
cannot be identified, it appears in acceptance-notification output, but tweet
mode reports its ID and missing metadata on stderr instead of guessing. If no
selected acceptance can produce a draft, the command fails.

Full titles are preserved. Announcements are not split or truncated to a
character limit; review and edit the text before posting.

Selection is based on message text, not an authoritative OpenReview lookup.
Unrecognized wording may be missed, and later status changes are not reconciled.
Counts describe identifiable papers in the selected messages.

No matches produces empty stdout in text mode or `[]` in JSON modes. Successful
runs return 0, processing errors return 1, and invalid arguments return 2. To save
output, redirect stdout to a new file; never redirect over the input file.

## Tests

```sh
cd /Users/felixhu/src/openreview-notifications
python3 -m unittest discover -s tests -v
```
