# Working-groups slide sync

AdminBot keeps the "Scaling to 50-100 Technical Members" slide current. The slide has six rounded
boxes, one per working group, and each box holds rows of round member photos. AdminBot checks the
slide every week, and again shortly after a member change that could affect it.

Every change becomes a `slides.sync_working_groups` proposal (tier T2). Nothing is written to the
deck until an admin approves it.

The sync is **append-only**:

- It never deletes or moves an image that is already on the slide.
- It only adds round faces after the last face in a box.
- The only images it will ever touch are the ones it placed itself.

## Who goes in which box

A member belongs in a box when both of these hold:

1. **Eligible.** `isThemeMeetingEligible` in `workflows/members/research-themes.ts` passes: a full
   member or major coauthor who is not alumni.
2. **On topic.** The member matches the box's rule.
   - Five boxes use a research theme from `memberThemeIds`, the deterministic phrase classifier
     over `research_topics` and `projects`.
   - Power Concentration uses keywords instead (see the table).

The theme meetings and `#meeting-*` channels use the same theme rule. Meeting attendance is not
used, because it is only filed when someone uploads a Zoom export, so it is sparse and weeks
behind.

| Box                 | Rule                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Interpretability    | theme `mech_interp`                                                                          |
| Power Concentration | keywords "power concentration", "concentration of power", "AI governance", "AI and democracy" |
| Adversarial Defense | theme `adversarial_defense`                                                                  |
| Multi-Agent         | theme `multi_agent`                                                                          |
| Loss of Control     | theme `loss_of_control`                                                                      |
| Causality           | theme `causal_llm`                                                                           |

How the Power Concentration keywords work:

- They are whole phrases, matched as whole words in a member's topics or projects. "ML powered
  causality" and "Power analysis" do not match.
- They are defined in `WORKING_GROUP_BOXES` (`workflows/slides/working-groups.ts`) and are used
  only for the slide.
- `RESEARCH_THEME_IDS` and the classifier are unchanged, so no meeting channel appears for this
  box.

Members with no `http(s)` `avatar_url`, or whose avatar is Slack's default silhouette, are skipped
and listed under `skipped_no_photo`. The Slack roster sync no longer stores the silhouette: it drops
the image when Slack reports `is_custom_image: false`, and it recognises the silhouette URL
(`/img/avatars/ava_NNNN`, directly or as a Gravatar fallback) for avatars stored before this check.

**The slide has more faces than the rule finds.** Faces on the live slide were placed by hand from
more sources than the roster topics, so in most boxes there are more faces than the rule produces.
This is why the sync only appends. A person on the slide whom the rule does not select stays
there.

## How the slide is read

`workflows/slides/face-layout-measure.ts` finds the slide by its title, then finds each box by its
heading.

**Which images belong to a box.** A face is any roughly square image: width to height between
0.8 and 1.25. A face belongs to a box in one of three cases:

- It carries an AdminBot object id, `adminbot_face_<group>_<hash>`.
- Its centre lies inside the box's content area, below the heading.
- It sits just outside a box, where faces spill from a crowded box: to the right of and below the
  box's top-left corner, within one box height of the box, and 0.5–2 times the box's typical face
  size.

**How the layout is measured.** The face size, the gaps, the column count, the margins and the
outline are measured only from faces whose centre is inside the box. A spilled face never sets the
grid.

**Who each face shows.** Each face is tied to a member in one of three ways:

- **Faces AdminBot placed.** The alt-text description is `adminbot:member:<member id>`. AdminBot
  also mints the object id. These are the only faces AdminBot owns.
- **Faces placed by hand.** The alt text (title or description) holds the member's name, preferred
  name or email, and matches exactly one member. AdminBot uses these only to avoid adding the same
  person twice. It never moves or deletes them.
- **Faces nobody can be tied to.** These are never touched, but they still take up room in the
  box.

## How the slide is changed

`workflows/slides/face-layout-plan.ts` handles one box at a time:

1. **Who is missing.** These are members who belong in the box and are not already shown, either
   by an AdminBot face or by a matching hand-placed face. A spilled face still counts as shown.
2. **Where they go.** New faces continue after the last face of the last row:
   - at the measured size and spacing;
   - wrapping at the measured column count, or at the right edge of the box;
   - never on top of an existing image.
3. **Full boxes.** If even one new face would not fit inside the box, the box is reported as
   `full` and nobody is added to it. The people who did not fit are listed under `no_room`, and
   the box is never allowed to overflow. To make room, tidy the box by hand; the next run fills it.
4. **People who left.** AdminBot only lists a face it placed itself under `would_remove`.
   - The face is deleted only when `ADMINBOT_SLIDES_ALLOW_REMOVALS=1`.
   - Hand-placed faces are never removed.

`workflows/slides/face-layout-requests.ts` turns the plan into a Slides `batchUpdate`, in this
order:

- `deleteObject`, only for faces AdminBot placed, and only with removals on;
- `createImage`, with an id starting `adminbot_face_`;
- `updatePageElementAltText` on each new face: the title is the member's name and the description
  is `adminbot:member:<id>`.

The executor refuses everything else, including:

- moves, resizes, and text edits;
- deleting anything the plan did not list;
- an image whose URL is not that member's photo;
- alt text on anything other than a face created in the same batch, or naming a different member.

**Running it twice changes nothing.** Once the missing people are on the slide, the next run
proposes nothing.

**Checks before writing.** The executor reads the slide again just before writing, and refuses in
any of these cases:

- a face it was about to delete has moved, or has lost its tag;
- an image now sits where a new face would go;
- a new face's id already exists.

The next run then makes a fresh plan.

## Round faces

The Slides API cannot apply a shape mask to an image. Instead, AdminBot renders each new face as a
round PNG on the server (`connectors/slides-face-image.ts`):

1. Download the member's photo: `https` only, 8 MB at most.
2. Crop it to a square with `rastermill`.
3. Cut a transparent circle and paint the outline measured from the box's existing faces (colour
   and weight). The rendered face therefore matches its neighbours at the same size and spacing.

The PNG is then hosted where Slides can fetch it (see the Limits section for the sharing details).
A face whose photo cannot be fetched or rendered is left out of the batch and reported under
`faces_not_added`. The rest of the batch still goes in.

## Triggers and approval

| Trigger           | How                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly            | The cron job `adminbot-slides-working-groups` runs at `20 7 * * 1`. It calls `scripts/adminbot-slides-working-groups-cron.sh`, which sends `POST /slides/working-groups/apply` with `{"trigger":"schedule"}`.                                        |
| Member change     | Runs after a member save that changes something the slide shows: a new eligible member, eligibility, box membership (themes or keywords), name, preferred name or photo. Saves close together trigger one run, after `ADMINBOT_SLIDES_DEBOUNCE_MS` (60 s by default). |
| Manual            | An admin sends `POST /slides/working-groups/apply`.                                                                                                                                                                                               |
| Preview (no card) | `GET /slides/working-groups/preview` returns JSON. For each box it lists `added`, `no_room`, `would_remove` and `skipped_no_photo`. `?format=svg` draws the slide before and after, with round faces showing initials and no photos.                  |

**Why cron rather than a Google Calendar trigger.** The weekly cron job is the dependable stand-in
for a Calendar trigger. It runs on the AdminBot host without a Calendar watch channel to renew, and
a missed week does not depend on Google delivering a push notification. Together with the
member-change trigger, it catches both roster edits and hand edits to the slide.

**Approval cards.**

- All routes are for admins or the service token only.
- Each run supersedes any earlier open proposal, so there is only ever one card for the slide.
- A run that produces exactly the same requests as the open card returns that card unchanged.

**Unattended runs.** With `ADMINBOT_SLIDES_AUTO_APPLY=1`, a plan that only adds faces is approved
as `adminbot:slides-auto-apply` and written in the same run, so the weekly job keeps the slide
current with nobody watching the queue. A plan that deletes anything still waits for an admin.
Re-running is safe: once the slide matches, the plan is empty and nothing is written.

**Failures.** A failed read or write is audited as `slides.working_groups_failed` and the cron script
exits non-zero, which the automation health check turns into one admin alert. A deck that is not
configured is also a failure (the script used to exit 0 on the 503 and hide it). To turn the job
off on purpose, set `ADMINBOT_SLIDES_WORKING_GROUPS_DISABLED=1` in the cron environment.

## Setup

AdminBot reads and writes the deck through the `gog` CLI, as `GOG_ACCOUNT`. This is the same
Google account (`jinesis.adminbot@gmail.com`) that every other AdminBot Google action uses. There
is no separate service account or key file.

1. **Share the deck.** Give `jinesis.adminbot@gmail.com` **Editor** access to the deck.
2. **Create the face folder.** Make a Drive folder owned by that account to hold the rendered
   faces, for example "AdminBot slide faces". Do not share the folder.
3. **Check the gog binary.** The `gog` on the AdminBot host must support `gog api call` and must
   not have a baked safety profile, which refuses `api call`. Each call is limited with
   `--enable-commands-exact` to the single method it makes:
   - `api.slides.presentations.get`, to read the deck;
   - `api.slides.presentations.batchupdate`, to write it;
   - `drive.upload`, `drive.share` and `drive.unshare`, for the faces.

   The token scope defaults to Drive. To use a different granted scope, set
   `ADMINBOT_SLIDES_GOG_SCOPE`.
4. **Set the environment.** See `deploy/aurora/adminbot.env.example`.

   ```bash
   GOG_ACCOUNT=jinesis.adminbot@gmail.com
   ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID=1ex2yVGmhXuNT8ei-TbA_-6M9x0X9x4FEOBhAcepIX94
   ADMINBOT_SLIDES_FACE_FOLDER_ID=<id of the folder from step 2>
   # ADMINBOT_SLIDES_WORKING_GROUPS_SLIDE_TITLE="Scaling to 50-100 Technical Members"
   ADMINBOT_SLIDES_WRITE=0
   # ADMINBOT_SLIDES_ALLOW_REMOVALS=0
   # ADMINBOT_SLIDES_AUTO_APPLY=0
   ```

5. **Check the preview before enabling writes.** Restart AdminBot and open
   `/slides/working-groups/preview?format=svg` and the JSON preview. For each box, check:
   - `added` lists exactly the people you expect;
   - any box marked `full` lists its `no_room` people;
   - nothing unexpected appears under `would_remove`.
6. **Enable writes.** Set `ADMINBOT_SLIDES_WRITE=1` and restart. While it is `0`, approved proposals
   are validated but nothing is written.
7. **Turn on unattended runs.** Set `ADMINBOT_SLIDES_AUTO_APPLY=1` (needs `ADMINBOT_SLIDES_WRITE=1`
   and `ADMINBOT_SLIDES_FACE_FOLDER_ID`; AdminBot refuses to start otherwise) and restart.
8. **Register the cron job.** Run `scripts/adminbot-cron-sync.sh`.

## Limits

- **Faces are shared for a short time.** Slides fetches `createImage` URLs from Google's servers
  without signing in, so a private Drive file cannot be read. Each rendered face is shared as
  "anyone with the link, reader" for the length of one `batchUpdate`, then unshared straight away,
  whether the update succeeded or not.
  - During that window, anyone holding the URL could view the face. The URL contains Drive's
    unguessable file id and is never posted anywhere.
  - After the update, the files stay private in the face folder. Slides keeps its own copy of the
    image.
  - If unsharing fails, the result lists the file under `link_sharing_not_removed`. Remove the link
    in Drive by hand.
- **Full boxes are not resized.** The sync never shrinks or moves faces to make room. It reports
  `full` instead.
- **Hand-placed faces are never cleaned up.** Faces of people who left, and stray faces off the
  edge of the slide, stay until someone removes them by hand. The sync also avoids adding a second
  copy of a person when the hand-placed face's alt text names them.
- **New faces go on top.** Images created by the sync are placed in front of everything else on the
  slide.
