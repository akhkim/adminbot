# OpenReview announcement drafts

Admins can open **General Tools → OpenReview To Tweet**, upload a notifications JSON
array, choose a conference and an exclusive UTC cutoff date, and generate tweet drafts and PNGs.
The imported parser selects acceptance notifications and preserves workshop/track labels.
Draft text is editable and copyable; images are downloadable paper lists. Editing tweet text
does not change the images. Review titles, tracks, institution handles and length before posting.

The tool reads author metadata from OpenReview, matches exact identifiers against member
`openreview_id` values in AdminBot's existing SQLite store, and adds valid `twitter_url` handles
to each conference's tweet, deduplicated across papers. It supports `authorids` and structured
`authors[].username`, including API v2 value wrappers. Stored OpenReview profile URLs are accepted.
Names are never used to guess identities. Missing authors, duplicate member identities, unavailable
papers and invalid/missing X handles appear as warnings; review them before sharing.
If an acceptance has no paper link, the adapter searches the full uploaded export (including older
notifications) for the same exact venue/year/track and submission number. Conflicting forum IDs are
rejected; an existing direct paper link is preserved.

It posts nothing and does not write to SQLite. Only paper IDs are sent to OpenReview; the roster
and notifications stay local. Notifications are passed to Python over stdin; generated images use a
temporary directory removed after each request. Input is limited to 26 MB at the API (25 MB
file limit in the UI), 10,000 notifications and 100 selected papers. One generation runs at a
time with a 180-second process timeout. Browser disconnects cancel generation.

## Setup

Python 3.10+ is required. PNG output also needs Pillow. Create an ignored environment:

```bash
cd openclaw-adminbot
python3 -m venv state/notification-drafts-venv
state/notification-drafts-venv/bin/pip install -r scripts/openreview-notifications/requirements.txt
export ADMINBOT_NOTIFICATIONS_PYTHON="$PWD/state/notification-drafts-venv/bin/python"
```

Set credentials in the same terminal before starting the normal service or development launcher:

```zsh
read 'OPENREVIEW_USERNAME?OpenReview email: '
read -s 'OPENREVIEW_PASSWORD?OpenReview password: '
echo
export OPENREVIEW_USERNAME OPENREVIEW_PASSWORD
```

An existing `state/openreview-venv` can be reused instead: install the notifications requirements
there and point `ADMINBOT_NOTIFICATIONS_PYTHON` at its `bin/python`. No credentials belong in
frontend environment variables or uploaded JSON. Restart a running backend to pick up its environment.
Without Pillow, turn off **Include downloadable PNG images** to generate text only.
Production and fixture launchers configure the adapter path. No model credentials are required.
Missing OpenReview credentials or failed sign-in returns an actionable error when a paper needs lookup.

The original local project was copied without changes into `scripts/openreview-notifications/`.
`SOURCE.json` records source file hashes; `adminbot_bridge.py` is the separate service adapter.
The original command-line interface and tests remain available:

```bash
cd scripts/openreview-notifications
python3 -m unittest discover -s tests
```

The API is `POST /tools/notification-drafts` with an admin member bearer session and
`{ notifications, min_date, conference, template, images }`. Template is 1–10 or null
for random; images is a boolean. Successful responses contain `announcements`, base64 PNG
`images`, and skipped-record `warnings`. Invalid/mixed venue evidence fails rather than
producing a misleading draft. Nothing is posted automatically.

## Authenticated author lookup (standalone)

The repository already uses the official `openreview-py` client through
`scripts/adminbot-openreview.py`. Install its existing requirements into an ignored environment:

```bash
cd openclaw-adminbot
python3 -m venv state/openreview-venv
state/openreview-venv/bin/python -m pip install -r scripts/adminbot-openreview-requirements.txt
```

In macOS's default zsh, enter credentials interactively so the password is not saved in shell history:

```zsh
read 'OPENREVIEW_USERNAME?OpenReview email: '
read -s 'OPENREVIEW_PASSWORD?OpenReview password: '
echo
export OPENREVIEW_USERNAME OPENREVIEW_PASSWORD
state/openreview-venv/bin/python scripts/adminbot-openreview.py paper-authors --id YOUR_PAPER_ID
unset OPENREVIEW_USERNAME OPENREVIEW_PASSWORD
```

This uses API v2 (`https://api2.openreview.net`) and returns JSON containing the title,
`authors`, and `authorids` (profile IDs or emails). Missing author fields remain null;
`authorids_available: false` means no identifiers were returned, not that the paper has no authors.
Login does not grant access to hidden author information. Expected failures return `ok: false`;
check that field rather than the process exit code. No database writes or posting occurs.
The announcements UI performs this lookup automatically for linked papers during generation.

Client setup follows the [official OpenReview instructions](https://docs.openreview.net/getting-started/using-the-api/installing-and-instantiating-the-python-client).
