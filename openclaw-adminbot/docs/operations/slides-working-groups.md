# Working-groups slide sync

AdminBot keeps the "Scaling to 50-100 Technical Members" slide current. The slide has six rounded
boxes, one per working group, each holding rows of round member photos. AdminBot updates it
weekly, and again shortly after a member change that could affect it. Every change is a
`slides.sync_working_groups` proposal (tier T2) that an admin approves before anything is written
to the deck.

## Who goes in which box

A member is in a box when both of these hold:

1. **Eligible:** `isThemeMeetingEligible` in `workflows/members/research-themes.ts`. That means a
   full member or major coauthor who is not alumni.
2. **On the box's theme:** the theme appears in `memberThemeIds`. This is the deterministic
   phrase classifier over the member's `research_topics` and `projects`.

The theme meetings and `#meeting-*` channels use the same rule, so the slide and the channels
always agree about who is in a group. Meeting attendance is not used because it is only filed
when someone uploads a Zoom export, so it is sparse and weeks behind.

| Box                 | Theme                 |
| ------------------- | --------------------- |
| Interpretability    | `mech_interp`         |
| Power Concentration | none (left untouched) |
| Adversarial Defense | `adversarial_defense` |
| Multi-Agent         | `multi_agent`         |
| Loss of Control     | `loss_of_control`     |
| Causality           | `causal_llm`          |

**Power Concentration is not maintained.** The roster has no theme for it: the classifier counts
"power concentration" under `loss_of_control`. AdminBot measures this box but never changes it.
Adding a theme to `RESEARCH_THEME_IDS` and to `WORKING_GROUP_BOXES` in
`workflows/slides/working-groups.ts` would bring it under the sync.

Members with no `http(s)` `avatar_url` are skipped and listed under `skipped_no_photo`. Their box
is still updated for everyone else.

## How the slide is read

`workflows/slides/face-layout-measure.ts` finds the slide by title and finds each box by its
heading. Then, for each box:

- **Which faces belong to the box.** A face is any image that is roughly square (width to height
  between 0.8 and 1.25). An image is assigned to a box in one of three ways:
  - It carries an AdminBot id: `adminbot_face_<group>_<hash>`.
  - Its centre lies inside the box's content area, below the heading.
  - It sits outside every box but close to one, as faces spill out of a crowded box. A spilled
    face is claimed by the nearest box when all of these hold:
    - it is to the right of and below the box's top-left corner;
    - it is within one box height of the box;
    - it is 0.5–2 times the size of the box's typical face.

  Spilled faces are counted, so they are moved back in rather than added a second time. A
  face-sized logo elsewhere on the slide is not claimed.
- **Layout.** AdminBot measures the face size, the horizontal and vertical gaps, the number of
  columns, the margins, and the order of the faces (row by row). These come from faces that sit
  inside the content area.
- **Overflow.** The box counts as overflowing when any face extends past the box or overlaps
  another face.

**Matching faces to members.** AdminBot finds faces it created by their id. A face placed by hand
is matched through its alt text (title or description). The alt text can hold the member's name,
preferred name, email, or `adminbot:face:<member id>`, and it must match exactly one member. An
image that matches no one, or more than one person, is never moved or deleted.

## How the slide is changed

`workflows/slides/face-layout-plan.ts` handles one box at a time:

1. **Keep** the faces of members who are still in the group, in their current order. **Remove**
   identified faces of members who left. **Add** missing members, sorted by name, at the end.
2. **Lay out** the faces at the measured size and spacing, first with the measured number of
   columns and then with as many columns as fit.
3. **Shrink only on overflow.** When the faces do not fit, every face in that box shrinks by the
   same factor, and the gaps shrink in proportion. AdminBot picks the column count that keeps the
   faces largest and centres the grid both ways. Other boxes are unaffected.
4. **Block** a box instead of guessing in these cases:
   - faces would have to shrink below 0.2 in;
   - there is an unidentified image in a box that needs changes;
   - a face is grouped or rotated.

   The reason appears in the preview and in the proposal.

A box that already matches the roster produces no requests. Running the sync again straight after
an applied update therefore proposes nothing.

`workflows/slides/face-layout-requests.ts` turns the plan into a Slides `batchUpdate` with three
kinds of request, in this order:

- `deleteObject`
- `updatePageElementTransform` (absolute)
- `createImage`, using an id starting `adminbot_face_`

The executor refuses any other request type, and any request aimed at an object that was not
planned.

**Checks before writing.** Before writing, the executor reads the slide again and checks each
object it is about to move or delete:

- the object still exists;
- it is in the place the plan was made from.

If someone edited the slide after the proposal was made, the proposal fails without writing
anything. The next run makes a fresh plan.

## Triggers and approval

| Trigger           | How                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly            | Cron job `adminbot-slides-working-groups` runs at `15 7 * * 1` and calls `scripts/adminbot-slides-working-groups-cron.sh`, which sends `POST /slides/working-groups/apply` with `{"trigger":"schedule"}`.                                                |
| Member change     | Runs after a member save that changes something on the slide: a new eligible member, a change in eligibility, themes, name, preferred name or photo. Saves in quick succession trigger one run, after `ADMINBOT_SLIDES_DEBOUNCE_MS` (60 s by default). |
| Manual            | An admin sends `POST /slides/working-groups/apply`.                                                                                                                                                                                                  |
| Preview (no card) | `GET /slides/working-groups/preview` returns JSON, and `?format=svg` draws the slide before and after. The SVG shows grey circles with initials and no photos.                                                                                         |

All routes are for admins or the service token only. Each run supersedes any earlier open
proposal, so there is only ever one card for the slide. If a run produces exactly the same
requests as the open card, it returns that card unchanged. The weekly run and a burst of profile
saves therefore do not add to the approval queue.

## Setup

1. **Credentials.** Create a Google Cloud service account with the Slides API enabled and download
   its JSON key to the host, outside the repo.
2. **Access.** Share the deck with the service account's `client_email` as an **Editor**.
3. **Environment.** Set these variables (see `deploy/aurora/adminbot.env.example`):

   ```bash
   ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID=1ex2yVGmhXuNT8ei-TbA_-6M9x0X9x4FEOBhAcepIX94
   ADMINBOT_SLIDES_SERVICE_ACCOUNT_FILE=/etc/adminbot/slides-service-account.json
   # ADMINBOT_SLIDES_WORKING_GROUPS_SLIDE_TITLE="Scaling to 50-100 Technical Members"
   ADMINBOT_SLIDES_WRITE=0
   ```

   To use a short-lived token instead of the key file, set `ADMINBOT_SLIDES_ACCESS_TOKEN`.
4. **Check before enabling writes.** Restart AdminBot and open
   `/slides/working-groups/preview?format=svg`. Check that every box reads as `unchanged` or as
   the change you expect. Fix any `blocked` box on the slide, for example by giving a hand-placed
   photo alt text with the member's name.
5. **Enable writes.** Set `ADMINBOT_SLIDES_WRITE=1` and restart. While it is `0`, approved
   proposals are validated but not delivered.
6. **Register the cron job.** Run `scripts/adminbot-cron-sync.sh`.

**Optional: round photos.** `ADMINBOT_SLIDES_FACE_URL_TEMPLATE` sets a URL template containing
`{url}`, for example an image proxy that crops to a circle. AdminBot inserts the encoded photo URL
in place of `{url}`, and the result is the URL Google fetches. This sends members' photo URLs to
that proxy, so only use a proxy the lab runs.

## Limits

- **New faces are square.** The Slides API cannot apply a shape mask or crop to an image, so a new
  face is the photo as supplied, unless a face URL template points at a proxy that makes round
  images. Existing faces keep their mask.
- **Shrinking is one-way.** A box that shrank does not grow back on its own when members leave.
  Resizing the faces by hand resets the measured size.
- **New faces go on top.** Images created by the sync are placed in front of everything else on
  the slide.
- **Hand-placed faces need alt text** (a name, preferred name, email or `adminbot:face:<member id>`)
  that matches exactly one member. A face of someone deleted from the roster, or a name that matches
  two people, blocks its box until it is fixed by hand.
- **Spilled faces.** A face that spilled into another box's content area is counted in that box.
  The sync blocks that box as unidentified, or treats the face as a stranger. Faces more than one
  box height away, or above or to the left of their box, are not claimed.
- **Power Concentration** is never changed (see above).
- **Edits after planning.** The pre-write check covers only the objects a plan touches. A face
  someone added after the plan was made is not detected until the next run.
