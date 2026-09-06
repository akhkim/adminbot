# AdminBot Brainstorming

Restructured from `20260607_AdminBot Brainstorming.pdf` (90 pages). The wording of each item is kept
as written; what changed is the ordering — Developer Onboarding and the TODO come first, the loose
"TODO for Andrew" items have been filed into the feature group each one belongs to, and every item
carries a status marker set by checking it against the code in this repository.

**Status markers**

| Marker | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| ✅     | Implemented — a surface, workflow or action type exists for it         |
| 🟡     | Partial — some of it is built, the rest is named in the item           |
| ⬜     | Outstanding — no code found                                            |
| 💬     | Not a build task — policy, prose, a manual step, or a decision to make |

Status was determined by reading `extensions/adminbot/src/` (contracts, workflows, connectors, api)
and `ui/src/ui/adminbot/` (views, controllers, access table). Where a marker is ✅ or 🟡 the file
that carries it is named, so the claim can be checked. Every cited path and action type was verified
to exist.

---

## Contents

1. [Developer Onboarding](#developer-onboarding)
2. [TODO](#todo)
3. [Login and Task division](#login-and-task-division)
4. [Key achievements](#key-achievements)
5. [AdminBot Design Setup](#adminbot-design-setup)
6. [FeatureGroup1: Public-facing functions](#featuregroup1-public-facing-functions-useful-for-any-orgs-and-any-events)
7. [FeatureGroup2: Zhijing workflow management](#featuregroup2-zhijing-workflow-management)
8. [FeatureGroup3: People Management Functions](#featuregroup3-people-management-functions)
9. [FeatureGroup4: Paper management functions](#featuregroup4-paper-management-functions)
10. [FeatureGroup5: Lab sharing info](#featuregroup5-lab-sharing-info)
11. [Text Templates](#text-templates)
12. [Archived tasks](#archived-tasks)

---

# Developer Onboarding

Repo: https://github.com/akhkim/openclaw-adminbot-lab

- Runtime secrets: `adminbot-runtime-bundle.zip`
- Website: https://jinesis-admin.vercel.app/
- Todo list + task assignments: https://github.com/users/akhkim/projects/2/views/1

**Running UI locally:**

```bash
pnpm build
pnpm adminbot
node openclaw.mjs gateway run
pnpm ui:dev          # Vite, http://localhost:5173
```

Since our AdminBot is beneficial to everyone, I will support the LLM subscription fees up to 500USD
for every member who has spent more than 20 hours on it. You can use our AdminBot function to help
you create the reimbursement form.

**Admin Login**

- `admin@cs.toronto.edu`
- `jinesis-eurosafeai`

How to login: open https://jinesis-admin.vercel.app/, click the login button, use a
`@cs.toronto.edu` email, password `jinesis`.

By the way, everybody can PR your contributions to the GitHub! At the point of submission later to
Oct ARR, we will probably feed a long record of everybody's contributions across coding, design,
discussion, and let LLM suggest author orders according to the level of contributions. So keeping all
your work reflected by GitHub repo and Google doc edit histories are highly recommended! Thank you
for making this great project work out! 🤗

Co-authorship will be decided through GitHub contribution + Google Doc task distribution. Lines of
changes and commit count doesn't directly reflect impact, so Google Doc / work distribution will be
prioritized.

---

# TODO

Every task now lives in the feature group it belongs to. This section is the index: what is
outstanding, who owns it, and where the full item is written up.

## Blocking / highest priority

| Item                                                                                                                                                                                                             | Owner  | Section                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| ⬜ Lab Sharing backend — the entire tab is mock data (seven `MOCK_*` constants back every panel). Show "coming soon" until the backend exists, and hide feedback if its backend is not implemented               | —      | [FeatureGroup5](#featuregroup5-lab-sharing-info)                |
| ⬜ `zhijing-open-review-chairing` — the reviewing-cycle nudge ladder. It flagged a paper, but hadn't sent a reminder and was dismissed. Confirm the text templates with Yongjin                                  | Andrew | [FeatureGroup2](#-zhijing-open-review-chairing-to-be-completed) |
| ⬜ `zhijing-open-review-SAC` — tools for fast SAC decision; output a summary spreadsheet                                                                                                                         | Andrew | [FeatureGroup2](#-zhijing-open-review-sac)                      |
| ⬜ Test cases for every backend across our entire contact list — verify each access feature fired after onboarding (google calendar, slack, etc.), confirm Batch 3 with Zhijing manually, then scale to everyone | Andrew | [FeatureGroup3](#-andrew-test-cases)                            |
| ⬜ Users to onboard in each group — external-prof, interviewee, coauthor-minor/major                                                                                                                             | Andrew | [FeatureGroup3](#-andrew-todo-users-to-onboard-in-each-group)   |
| ⬜ Concurrency + offline access — load balancing across aurora/maple/conserto3 and OpenRouter, local queue, phone offline mode                                                                                   | Bryan  | [Backend design](#todo-for-bryan-concurrency--offline-access)   |
| ⬜ Some user roles do not have Email templates                                                                                                                                                                   | Andrew | [Text Templates](#text-templates)                               |
| ⬜ Onboarding steps should be their own page that tracks what is left, not the tail of "My profile" — it feels really cluttered right now                                                                        | Andrew | [FeatureGroup3](#step-3-one-shot-onboarding)                    |

## Also outstanding

| Item                                                                                                                                  | Owner  | Section                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| ⬜ Org Chart of leads and admins, including institute admins (Nini, Gizelda, Sabrina), so the ChatBot can answer "Who do I ask for X" | Andrew | [FeatureGroup5](#featuregroup5-lab-sharing-info)    |
| ⬜ `video-unlisted` — Zoom link in, trimmed talk out, uploaded unlisted to the lab playlist                                           | —      | [FeatureGroup2](#video-unlisted)                    |
| ⬜ `zhijing-location` — daily CSV of IP location + Slack time zone for the Canadian naturalization day count                          | Andrew | [FeatureGroup2](#-zhijing-location)                 |
| ⬜ Surprise-paper trigger and the national-security check                                                                             | —      | [FeatureGroup4](#papermentor-20)                    |
| ⬜ Three-month reflection nudge and the immigration-advice prompt                                                                     | Yara   | [FeatureGroup3](#step-6-after-30-days)              |
| ⬜ Chrome-only login warning flag, and X-follow verification                                                                          | —      | [FeatureGroup3](#step-4-verification-from-adminbot) |
| ⬜ MPI-reimburse: the Bernhard justification document                                                                                 | —      | [FeatureGroup1](#3--reimbursementbot)               |
| ⬜ Remove the git-error block shown to users; the forgot-password screen is ugly; strip `adminbot` from URLs; allow Google indexing   | Andrew | [Frontend design](#frontend-design)                 |
| ⬜ Redirect `admin.safe.eu` to the actual website; buy a domain (`harmony-ai.org/admin-bot` is a placeholder)                         | —      | [Website purchase](#website-purchase)               |
| ⬜ Grant report compilation (15 hours sprint) — map papers to Pepijn's areas, write the track-record sections                         | —      | [FeatureGroup4](#-pending-requests)                 |
| ⬜ EMNLP overview post — LinkedIn compilation, CG proposal track records, automated mailing list update                               | —      | [FeatureGroup5](#featuregroup5-lab-sharing-info)    |

## Timeline

- People onboarding
  - Full member: Done: batch 1 and batch 2. Todo: all full members (today)
  - Batch 1: select two users per category for early feedback (today) — Interviewee: Matiss;
    Coauthor-minor; Coauthor-major; Alumni; All the rest
- Today: Paper flow — ✅ add the per-person contribution for each project, by letting them put a
  weekly summary of 1-3 bullet points per week whenever their project stage is before the first paper
  PDF (`contracts/paper-weekly-updates.ts`)
- +3 days from now: Backend. Maybe you can feel free to (1) brush through the front end again for "My
  profile" and paper, (2) choose two users per access level to onboard them, and ask user feedback,
  (3) then start looking at the cybersecurity and privacy stuff.

## Zhijing's view (My Desk)

- ✅ Rec letter queue — `views/logistics-requests.queue.ts`
- 🟡 Overleaf reading queue
- ✅ Adoption rate to check
- ✅ Everybody's timeline availability
- 🟡 Other tasks: such as reviewing dagstuhl summary, grant report
- ⬜ Hidden tasks: Daniel Vector Institute communication given "activeness" status of a member
- ✅ My desk: combine and rename Adoption and thin timelines to "Adoption Rate: Who to remind to use
  AdminBot?" Three columns, profile completion, timeline, papers. Make this ignore alumni, if
  anything is empty (nothing is outstanding), move it down, remove the subtitle description, and
  remove waiting on your approval section — `views/professor.ts`
- ⬜ Nudge who is in the Monday meeting invite + full members who miss two meetings in a row to make
  sure to join the meeting. _(`workflows/meetings/attendance-nudge.ts` covers attendance nudging; the
  two-in-a-row rule is the gap.)_

## Not a build task

- 💬 Zhijing geolocation tracing?
- 💬 Lily mentioned she has constant reminders altho she has filled out everything
- 💬 Disable chat temporarily, calendar
- 💬 Remove openclaw update
- 💬 What to expect figure less realistic names
- 💬 Text Jiarui the email
- 💬 For Vincent W.: create analysis research doc template
- 💬 Check out Samuel's AI coding agent
- 💬 Check with Zhijing whether the access levels are working well for our non-full members; prepare
  for recorded zoom interviews for people's pilot user experience
- 💬 Batch 3 email improvements

---

# Login and Task division

Different subteams of AdminBot (the Do-ers are fully occupied for 5 days):

- `#proj-adminbot-modular-task-coders`
  - Orchestrator: Andrew (for all), Joeun (for the paper pipeline)
  - Modular functions: Andrew 50% capacity, Zaryab, Aryan, Luke, Gopal, Memo, Joeun 50% capacity
  - Front end: Yang Yang, Yara
- `#proj-adminbot-writer-and-designer`
  - Do-ers: David, Joeun 50%, Zhijing
  - Tasks: David and Zhijing write email templates. Joeun write PaperPipeline design spirit and
    decision-flowchart
- `#proj-adminbot-feedback-givers`
  - Ayush, Jordan, Yann, David Jenny, and many others
- Advanced version:
  - 🔒 `proj-adminbot-senior-swe`
    - Task: reconstruct the whole codebase by better code architecture and database
    - Teachers: Angelo, Arth, Samuel
    - Learners: Andrew 50% capacity, Joeun 0%

---

# Key achievements

- Efficiency for well defined repeated tasks, so the remaining human interactions can be for
  high-level and profound research discussions, but not the low-level repeated logistics. We can
  think of us as the "SAP for academic lab".
- Communication effect, to be comprehensive and systemic for people with all backgrounds (once we set
  up the standard workflow, and ponder on each text template multiple times).
- Democratizing education for all, and ensuring fairness.
- Contributing to our broader research agenda on "AI for Bureaucracy", and think of us as the
  modern-time Ford :).

## Audiences

- MPI admin
- Joseph Jay Williams, Igor

---

# AdminBot Design Setup

## Design Spirit

- Still make the interactions with the user more human like (eg from a human-feeling account),
  because sometimes people systematically ignore all AI messages. However, our admin bot functions
  are all after careful thoughts, so we want people to read them with heart.
  - For any reminder, elevate to Zhijing to send personal messages when the action is never taken.
- What to automate, and what not to automate
  - Automate: very clear deductive results, well-defined and unambiguously optimized
  - Middle ground: anything that should be revisited every 6 months to update the algorithm
  - Not to automate: diversity-related actions, creativity, core of research, people's customization,
    etc. Risks: scaling of the same type of error via our systemization

## Labor division

- High-context tasks: Andrew, [tba]
- Low-context tasks (e.g., most of the public-facing ones): any member's help would be appreciated
- A task for senior author: design the "router" function of whether anything is for AdminBot or for
  team leads/seniors or for peers or for Zhijing only. Needs some philosophical reasoning

## Frontend design

**TODO for Andrew:**

- ⬜ Remove this chunk of git errors for users
- ⬜ Forget password currently looks pretty ugly
- ⬜ A bunch of URLs have "adminbot" in them, but we can totally omit —
  `https://jinesis-admin.vercel.app/adminbot/deadlines?signedOut=login`
- ⬜ Accept Google indexing. Some of our "General Tools", e.g., AI deadlines page should allow google
  search index
- ⬜ Look into redirecting `admin.safe.eu` to the actual website
- 🟡 Clean up the admin view so we omit unnecessary functions (by keeping the code, and only disable
  the view) and cluster the important functions intuitively

**✅ Site global setting:** update logo to ours; update site title.

### Frontend action items (in order of priority)

1. ⬜ Lab Sharing → "coming soon" until backend is implemented. Also hide feedback if mechanism
   backend not yet implemented. _(The tab renders in full today but every panel is mock —
   `views/lab-sharing.ts`.)_
2. ✅ Deadlines page: list workshop names, filter only relevant ones to avoid clutter
3. Projects and papers:
   - 🟡 Need to create visually distinct sections → color-coded? Right now too much info / not sure
     where to look
   - 💬 Need clarification: keeping "draft linkedin post" or just the linkedin box in social drafts?
   - 🟡 Author list / feedback givers / aimed conference → should be dropdowns?
4. ⬜ Suggest renaming "reimbursement form prep" to "reimbursement support"? Should make it into a
   stepper (start by uploading receipts → adminbot llm → form preview → generate and confirm)
5. 🟡 Time Availability: maybe simplify by creating an add-commitment button that opens the rest of
   the forms so main focus is always current commitments / big deadlines / special notes?
   - 🟡 Big deadlines take less vertical space
6. ⬜ In PaperFlow diagram: dragging across diagram selects diagram text
7. ⬜ Make URN typable so they copy and paste
8. 🟡 Remove deadlines from dashboard, and only show a small widget for next two deadlines (union of
   public and personal deadlines)

## Backend design

### Data structure / database / codebase architecture

**People structure**

- ✅ Username as an ID. Camel case "GivennameSurname" by default (or first given name, and first
  surname, e.g., in the case of Portuguese names with 5 names etc). Not sure about "Julius von
  Kugegeln" type of names. And allow users to suggest a correction if we have an error, for the
  admins to review. — `contracts/person-names.ts`

**Paper id or project id**

- ✅ Backend id: `yyyymmdd-index`, e.g., `20260805-05` (uniq)
- 🟡 Associated alias: `proj-tamperbench`, `proj-adminbot*`
  - A separate database table: proj → meeting
  - `meeting-multi-agent: proj-elect-collusion`
- 🟡 Rename Short name → alias, tell them it must be same as slack channel name if already exists.
  Check box for existing slack channel to check if name correctly matches
- 🟡 Paperflow alias and ID implementation (check that), and alias will be used to make slack channels
  (`proj-alias`) — `slack.create_channel` exists, alias wiring to confirm

### Cookie setup

✅ Prompt: "Our system wants to know your location to enhance our collaboration and event invites.
Would you like to share your city location?" — `views/location-prompt.ts`

### Frontend

- Frontend options: Slack messages; Emails; Web portal; Lab spreadsheet, or lab google drive folder
- 🟡 Make the adminbot-sourced email not go to spam
  - Yang Yang: I looked into this and I think it gets sent to spam because to google it looks like a
    phishing email. I think we either have to switch to a `cs.toronto.ca` email or we just have to
    build reputation because the email is a newer gmail.
  - Make this spacing even less (maybe like how much the chatbot has)

### HCI: mid-urgency

✅ For every task, we ask users to "thumb up" or "thumb down" given the overall output. And provide a
chance for them to perform the correct actions, as a supervised learning sample for our AdminBot.

- ✅ Given that we are aiming for the upcoming Aug deadline, can you enable user experience of (user
  name, date of experience, rating of their experience by 1-5 stars) for every individual function
  that we have made available? — `contracts/feedback.ts` stores one row per member per feature, with
  a validated 1-5 rating, an optional comment, the member's name and the timestamps. A member who
  rates the same tab twice is changing their mind, not voting twice.
- ✅ Have an "i" circular button, where you put the `github_file_link` if the user wants to improve
  this function themselves, and issue a PR — `ui/src/ui/adminbot/feedback-tab.ts`

### Private-vs-public access

1. Step 0: prepare for files with different access [Info Access]
2. Step 1: user-frontend, or user-backend, or admin-backend sends query to our website's AdminBot
3. Step 2: Jinesis' private server (aurora or maple server) will first de-compose the query into
   tasks into privacy-free (or "public"), and privacy-protected (or "private") subtasks, and access
   level constraints (with cybersecurity protection)
4. Step 3:
   - We run LLMs on our local server for any subtask that is private OR public+easy_task
   - Optionally decide whether to run 32B on aurora
   - We issue API queries to OpenRouter, using models up to Fable 5, for any subtask that is
     public+hard_task
5. Part of Step 3: define our lab's cybersecurity tasks
   - If an interviewee asks our LLM "Get Zhijing's password for arXiv", then we need our AdminBot
     firmly rejects it. Claude has only "tool calls" and "data info" from what the user has access to.
     Or we let the students themselves register their Google Authenticator API.
   - But if an interviewee asks for "how to reimburse my 100$ API cost?", then we route it to the
     Guidebook section
6. Step 4: we will combine responses from `local_server_responses` and `OpenRouterAPI_responses` to
   an overall answer or action

_Status: 🟡 — the privacy broker every payload crosses exists (`extensions/adminbot/src/privacy/`)
and the model runs with `tools.profile: "minimal"` (no shell, no filesystem, no browser); the
local/remote task decomposition above does not._

### TODO for Bryan: Concurrency + Offline access

⬜ If the DCS server is down or crashed the request for unknown reasons (eg too many concurrent
requests), record the exact request, and call the AWS server or escalate to humans, e.g., Andrew or
Zhijing.

If we know this time >8 people are using the LLM-involved action, then call APIs, for up to 100-500
concurrent requests on OpenRouter API.

Loadbalancing (shared across AdminBot and PaperMentor: kubernetes is an overkill):

- Local server: first triggers a non-LLM-involved check for the # concurrent requests
  - If less than 100 public OpenRouter API and less than 8 aurora-based LLM requests, then go with
    OpenRouter API
  - If more, then let the user wait and pause. Add into the queue.
- Two server types: aurora and maple: RTX6000, conserto3: H100

⬜ Local Queue: enable off-line access from Google Chrome extensions, just like the Google doc
off-line extension; also enabling this on phones.

> For frequent off-line occasions, develop phone off-line versions similar to WhatsApp, but not like
> Slack, which is heavily reliant on the Internet. Two types of off-line things: one is to only allow
> read access and manual edits. The other off-line type is to allow some small LLMs on the phone,
> which is very advanced, and we should push for it as an interview task for advanced coders.

_Status: two pieces of this already exist and are worth building on rather than around. Offline
editing has a foothold — `ui/src/ui/adminbot/data/logistics-draft.ts` persists in-progress logistics
requests (files included) to IndexedDB on the member's own device, and degrades cleanly where a
browser blocks it. Request concurrency has one too — `workflows/papers/workshop-match-llm.ts` caps
parallel model calls with `maxConcurrentRequests`. What is missing is the cross-server load balancer,
the shared queue, and anything on phones._

### ✅ TODO for Andrew and Zhijing: Read-vs-write: Action Access

- Read access: all docs
- Absolutely no edit/write access to send any emails to any members out of the lab, e.g., to UofT
  president, but only call functions within our AdminBot website platform to send messages, or via
  slack on the DCS platform. Open to negotiation and discussion on this.
- No access to tamper our google drive folder, etc. No access to bank accounts.
- Edit and write access to post on LinkedIn and Twitter
  - Needs a classifier for EuroSafeAI posts vs. Jinesis posts
    - All events on AI Safety or any of EuroSafeAI pillars goes to EuroSafeAI. All policies go there.
      E.g., the AI for Good workshops should have gone to EuroSafeAI.
    - The rest of all the pure ML research, or alumni status update goes to Jinesis
- Edit access for personal calendar, read-only for Jinesis calendar

Prompt question: how to systematically make sure the other lab members cannot tamper my calendar by
sending emails to our adminbot address? — All Google related edits require admin approval on the web
UI.

_Status: ✅ — this is the propose → approve → execute → audit gate in `src/kernel/`, with the action
types in `contracts/actions.ts`. An action type with no executor fails closed._

- ✅ Allow impersonation — `workflows/identity/auth.ts` carries `impersonated_by` on the session and
  re-reads the impersonator on every request, so demoting or deleting an admin ends the impersonated
  session; the routes are `POST /auth/impersonate` and `/auth/impersonate/stop` in `api/server.ts`

**Additional feedback after today's meeting**

Zhijing mentioned that it would be good to have use cases such as "given our contact/paper list,
draft twitter posts for the first 10 papers". Possible solutions included parsing columns with LLMs,
making clearly private v.s public sheets, etc.

I think if we have an adminbot postgresql database running on a server, we should not use the Google
Sheet anymore (to avoid data duplication). Instead, we can edit / consult a relevant dataset view
directly from the AdminBot frontend. Concretely, having a properly designed normalized database, have
RBAC (role-based access control) in postgres directly, and the sheet would show only the items each
user has access to (by design).

Then for the API, having some services on the server that query the database, and using this API as
tool calls by the LLMs, or only using the LLMs to select which tool call to run and then let the
front-end run it. It would be important to use placeholders in the data, because we don't want to
send sensitive lab information (e.g passwords) to Claude or even to local LLMs if possible?

_Status: 🟡 — the store is SQLite (`src/persistence/sqlite.ts`), not postgres, and the member
spreadsheet is still a live sync target (`lab_member.upserted`, `sheet.update_cells`)._

- 🟡 It would be the best if any of your programs needing to read the contact spreadsheet directly
  read from the Google spreadsheet online file, instead of relying on the excel local file. You can
  execute that for the email and update it for other coding files too.
- ⬜ Decide logic on merging private people list into contact sheet (e.g. graduation date)
- ⬜ Can you add alumni from my private sheet to new rows of the current superset spreadsheet?
- ⬜ Improve Zhijing's private sheet: add AAAI papers

### Feature overview

**✅ Definition of the "reminder" trigger, globally:**

1. General implementation: send a reminder by slack message + warning on the landing page +
   notification on the portal. If very important things have not been done in 55 days, then elevate
   to Zhijing to manually chase the user (three person DM, including adminbot, Zhijing, and the
   student). Exclude Alumni in Slack and email nudges, only shown in the portal. —
   `member_nudge.send`, `member_nudge.escalate`
2. Onboarding specific implementation
   - First sending the Email
   - Waiting for 5 business days, if no login or no edit, then send Slack message
   - +3 days: another slack message
   - +5 days: both elevate to Zhijing (showing up on my desk: nudge-required. Format: what needs to
     be nudged + user list) & whatsapp message to the phone number

   — `workflows/members/onboarding-followup.ts`, which deliberately plans both sweeps in one place so
   a member who has never signed in and a member mid-onboarding never both get chased

- 💬 Lily mentioned she has constant reminders altho she has filled out everything — worth testing
  against the sweep above before changing anything

**Function surfaces**

- ✅ Zhijing-only functions: email-to-calendar; `receipt-pdfs-to-reimbursement-form`;
  `whatsapp-to-actions-of-the-AdminBot`
- ✅ Member-facing backend: automatic onboarding and reminders
- 🤔 [Yara] Member-facing frontend: frontend for the students
  - ✅ Username: `FirstnameLastname`, e.g., `AdamSmith` (if overlap, then add joining year, e.g.,
    `AdamSmith2028`; if further overlap, then add joining year and month, e.g., `AdamSmith202801`).
    Unified password: `jinesis`. Allow the "change password" function from Oct 10 and after.
  - ✅ "My Profile" — include all basic info, and also My badges. Action 1: letting them "fill out all
    the blanks". Action 2: we can later do verifications to make sure everyone has done it correctly.
    Action 3: information suggestions, e.g., GPU onboarding by referring to the guidebook sections by
    url. Landing page, home after logging in, sidebar. Connect w/ diff people → interests.
  - ✅ "My Projects and Papers" — `views/my-work.ts`
  - ✅ "General Tools" (available even without login), in order: Logistics request; Reimbursement Form
    Prep (or ReimbursementHelper); Deadline Tracker; SocialMediaBot. Plus PaperMentor, Deadline
    Tracker, ReimbursementHelper (`receipt-pdfs-to-reimbursement-excel-form`). _(The access table
    opens four tabs to visitors: reimbursements, deadlines, opportunities, conference papers —
    `ui/src/ui/adminbot/access.ts`.)_
  - 🤔 "Lab Sharing" — chatbot for how-to and where-to; Zhijing's current status; add a "seek help on
    project" and search for members by name/tags/paper → send collab invite/call invite, can also
    send out a general call for help on proj (registers in "open projects" section), can also specify
    help needed (e.g., need annotators); see FeatureGroup5; open projects (incl. project
    descriptions, key tasks, timeline) and then express interest with your availability — a
    tag/filtering system (e.g., causality, multi-agent, etc.) for projects would also be helpful for
    both member- and lab-facing sides; find members by interest. **⬜ Frontend built, backend not.**
- ⬜ Lab-facing functions: social media of ICML as a group
- ✅ Admin-facing functions: Zhijing, Terry, Rahul, Andrew, … Username `admin`, password
  `jinesis-eurosafeai`, shared across all of us admins
- ⬜ Figure 1 overview of features — OOP: Students (attributes), Papers (attributes). Example figures
  whose styles we should learn from.

### Website purchase

- ⬜ `harmony-ai.org/admin-bot` (this is a placeholder url. You can feel free to explore domain name
  purchases, and reimburse to Gizelda. I like the spirit of "we are making AI sustainable or
  harmonious, by ensuring every of our research is used by some people/feeds into some realistic
  needs.")
- 💬 This adminbot tool is going to start subscription service (5 USD/person/year for labs, same as
  Slack enterprise plan), allowing for a for-profit small Swiss-based entity
- 💬 Others like "good.ai" or "good-ai.[anything]" or "helpful.ai" "useful.ai" is good as well

---

# FeatureGroup1: Public-facing functions (useful for any orgs and any events)

## 1. ✅ Deadline tracker

`views/deadlines.ts`, `workflows/deadlines/board.ts`, `contracts/deadline-proposals.ts`

- 🟡 Todo: can "Workshops" be explicitly added to the first two conference names, before explicit
  clicks of the expansion button?
- ✅ Can you allow clicks on all the workshop titles? The clicks should go to their workshop
  homepage's "Call for Papers" page, and also you should add an "openreview" submission button. —
  `workshopSourceLinks` in `views/deadlines.ts`
- ✅ At the end of the listing, allow the users to add a deadline, and admins will moderate later —
  `contracts/deadline-proposals.ts`, `deadline_proposal.submitted/revised/published`
- ✅ Allow a button of all past deadlines — the board has an `Upcoming`/`Past` period toggle
  (`board.ts`), and past rows render "passed" in muted colour instead of a countdown
- ✅ Show the workshops in gray, but main conferences with full color
- ✅ Trigger the "nudge" button when there is a match (assuming a csv file of paper titles; later
  Andrew can connect your code to the backend) — `workflows/papers/workshop-nudges.ts`
  - Early test cases: 1d 12:22:38 · Aug 26, 2026 · Workshop on Automated Knowledge Base Construction
    2026 · ARR — Terry: sycophancy; Khai: visual grounding. 3d 11:23:43 · Aug 27, 2026 · Natural
    Legal Language Processing 2026 Workshop · ARR commitment — Terry, Keenan. 7d 11:25:31 · Aug 31,
    2026 · Second Workshop for Research on Agent Language Models (ARR Submission) — Memo, CAIS. 11d
    11:25:21 · Sep 4, 2026 · 6th Multilingual Representation Learning Workshop · Direct submission —
    Abir.
- ⬜ Allow "add to my timeline" for any entry, if people have logged in
- ⬜ Allow google search indexing of `https://jinesis-admin.vercel.app/adminbot/deadlines`
- ⬜ Advanced function for Andrew: adminbot-commit when authors are not responding (e.g., graduated)
- ✅ The deadline section should also carry submission, rebuttal period, results date, camera ready
  and conference dates, highlighting only the submission date in the main view —
  `contracts/deadline-proposals.ts` carries the entry types, `board.ts` does the highlighting
- ✅ The deadline countdown should always be an archival venue, not a workshop. "Workshop of XXX"
  instead of "XXX workshop" — `board.ts`, `workshopGroupLabel`
- 🟡 Only workshops should be grouped, and ICLR abstract should be independent from full paper
  deadline, one item should not be grouped, ARR submission and conference both have ARR submission.
  Remove primary, secondary tag from conferences

## 2. ✅ Paper submission decision flow chart

Will be highly needed. You can first confirm and iterate with Yongjin, Samuel, and Terry. Then feel
free to host it on our AdminBot website, public-facing function, with no log-in needed:
https://venue-picker.vercel.app/

_Hosted in-repo at `GET /venue-picker` — `extensions/adminbot/src/web/venue-picker/`._

- 🟡 This flow chart should be triggered whenever a person asked our Chatbot. Disclaimer: we do not
  let chatbot give its own suggestions, but it only "routes" to our human verified guides: either
  sections in our guidebook, or these pre-programmed decision suggestions.

## 3. ✅ ReimbursementBot

`workflows/reimbursements/workflow.ts`, `views/reimbursements.ts`

- Warning on our website: students should be held accountable of their own reimbursement process.
- 🟡 Reimbursement tab read info

**Function a: UofT-reimburse**

- Derivative: `zhijing-reimburse` function
- Include reimbursement guide for users to read prior to submitting a request
- Guidebook for Jinesis Research Mentees (Internal Sharing Only)

**Function b: MPI-reimburse** — ⬜

Document 1: Justification doc. The justification is usually handled by the person who asks for
reimbursement and/or by the supervisor.

1. Justification for the visit
2. Why the task cannot be done by an internal research assistant
3. If Zhijing also travels, why more than one person needs to travel

Please write a whole text with all the details below in Bernhard's eyes to explain why it was
important that Bernhard sent you to the conference. It must be in the interest of MPI. Like this:

> David Guzman (Master student at ETH, supervised by me and Dr. Zhijing Jin) attended ICML because…
> It was of important interest to our institute because… I therefore agree to refund Mr. Guzman for
> his ICML trip to Seoul with up to a maximum total of 2500 EUR.
>
> Signature, Bernhard

Examples: `20241018_EMNLP_justification`, `20241018_EMNLP_justification_Giorgio.pdf`. Visiting MPI:
`20250311_Justification of student visits`. Zhijing's workshop: `20220720_Justifications_UAI.pdf`,
`20220720_Justifications_CogSci.pdf`, `Seattle_Justifications.pdf`, `Marburg_Justifications.pdf`. Or
social events: `20241219_EMNLP Justification.pdf`.

## 4. ✅ Text description to calendar event

E.g., website event copy and paste, or email copy and paste, to calendar event creation by a url
(given any Google account). Or the user can also choose to download `.ics` files if the url does not
work. — `workflows/calendar/event-draft.ts`, `calendar.send_invite`

## 5. ⏳ SocialMediaBot

- Input: Paper PDF. Output: twitter, linkedin, and bluesky post generation with correct tags
- Current progress by 2026-08-08 by Joeun: "Community Management API" request sent
- Yang TODO: make the interface on the MemberInterface

_Status: 🟡 — drafting, consent and circulation are built (`workflows/papers/linkedin-draft.ts`,
`social-posting.ts`, `connectors/social-draft.ts`, `social_media.post_publicly`). Bluesky appears in
the connectors; the paper-PDF-in entry point and the MemberInterface surface are the gap._

## 6. 🟡 (acquire from Han) Student achievements summary

For alumni or current members, update our student achievements summary (for Newsletters; or
demonstrating our alumni achievements) by their linkedin page changes. We can request every member to
put their linkedin user-id into our PersonProfile system?

_Status: `buildNewsletterDraft` in `extensions/adminbot/src/cv-scan.ts` already turns detected CV
changes — positions, education, awards, publications — into newsletter lines, de-duplicating a paper
that appears on several co-authors' CVs into one credited entry. It is driven by CV scanning rather
than by LinkedIn page changes, which is the part still open._

## 7. [🤔 Aryan] Emergency reviewer matching

🟡 Input: paper title and abstract in text form. Also Jinesis member experience-level / past papers /
if they are junior AND available. Output: Jinesis members to ask to be emergency reviewers, 1-2
candidates per paper. And then pass to Andrew to manually add them to OpenReview paper-reviewer
entries. — `workflows/papers/openreview-matching.ts`

## 8. 🤔 (acquire from Han) LinkedIn newsletter generation

⬜ Event and career focused; or news of the world.

- Ettore is free after late Sept
- Linkedin is tricky with scraping data → posts from URNs might be possible via Community Management
  API (waiting for access)
- Alternative solution: have people submitting their CV pdfs and we scrape those PDFs _(this is the
  route already taken — see `cv-scan.ts` under item 6)_

## 9. ✅ Member map

From daily slack time zone info + `login_city` info from the IP address they use to login to our
adminbot website portal, to generate the `…/lab_stats/member_map` website to visualize (is this
possible?) — `workflows/members/member-map.ts`, `views/member-map.ts`, `connectors/ip-geolocation.ts`

- Example: https://aisafety.com/communities
- ⬜ Visualize our research topics at https://aisafety.com/map given Zhijing's past papers

## 10. ✅ Opportunities board

Opportunities crawling — `views/opportunities.ts`, `contracts/opportunities.ts`, which carries a
`rising_stars` category among others.

- ⬜ Populate application form response link with the responses list

---

# FeatureGroup2: Zhijing workflow management

## Getting inspirations

Andrew, you should try a few reimbursements, by setting up email auto-forwarding of your receipts.
Feel free to nudge BERI people to set up your card asap :).

## "How To" for FeatureGroup2

Steps: 1. Forward email to `jinesis.adminbot@gmail.com`

## video-unlisted

⬜ We can set up a workflow:

- Input is a Zoom link
- Output is: trim the video to be focused only on the talk itself; upload one more video onto our
  jinesis youtube channel, with unlisted status, into our "jinesis latest research" playlist

_The destination already exists — `views/meetings.ts` links the unlisted playlist and names
`#jinesis-share`. What is missing is the trim-and-upload step that puts a video into it._

## 🟡 zhijing-sign function

`workflows/logistics/signed-documents.ts`, `logistics.send_signed_document`, `views/logistics.ts`

- Below are the todo for Andrew and the expectations for all of us who will frequently use this
  function
- ✅ Student front end: add a tab "logistics request with Zhijing". Under the tab, allow two
  functions: (1) request a signature on your PDF, and (2) request recommendation letters
- 🟡 Actual implementation:
  - Andrew should log into the `Jinesis.lab@gmail.com` account
  - Create a Google form with: Google form link (`Compute Expense Form.xlsx`); Name; Email; Google
    Drive file link for the PDF file to be signed (note: we recommended these files to be in our 1:1
    folder already, so the signing and reuploading will be very easy); Google Drive folder link of
    the 1:1 folder of Zhijing and you (so that the signed PDF documents will be uploaded there);
    (optional) context of signing and what it is for
  - Then click "export the form responses" into the Andrew-Zhijing 1:1 folder between us
  - In our 1:1 Andrew-Zhijing folder, can there be a subfolder full of the shortcut PDFs of
    everything to be signed? Basically, you can import it from the Google form answer column.
- The first round of users who needs ASAP before August 7 or so: Furkan, Yahang, Joeun
- 🟡 Meeting requests → use contact spreadsheet tab instead (column D is mandatory)

## ✅ zhijing-reimburse: receipt-pdfs-to-reimbursement-form

- Input: a bunch of receipts with specific file names, and PDF file of them (via google drive link)
  - Manual: Zhijing message Andrew via email or slack, and then Andrew fills in the spreadsheet
  - Via reading our spreadsheet: _Ongoing Reimbursements_
- Output: expense form (filled out), especially correct for the currency check
- Manual: Andrew attaching the expense form excel file and manually email reply

## ✅ zhijing-calendar

Input: emails forwarded to an adminbot address. Output: calendar entry onto my trip's calendar. —
`workflows/calendar/`, `connectors/gog.ts`

## ⬜ zhijing-open-review-SAC

- Needs: tools for fast SAC decision:
  `https://openreview.net/group?id=EMNLP/2026/Conference/Area_Chairs#assigned-submissions`
- Output: generate a summary spreadsheet

## ⬜ zhijing-open-review-chairing (To be completed)

TODO: it flagged a paper, but hadn't sent a reminder and was dismissed. [todo] Confirm the text
templates with Yongjin.

Workflow for each reviewing cycle:

1. Commit my reviewing load in the beginning of the cycle
2. When it is halfway closer to the reviewing submission deadline:
   - If I am an SAC, remind all the ACs to nudge reviewers
   - If I am an AC, directly nudge reviewers and tell them to submit early whenever possible
3. When it is 7 / 4 / 2 / 1 / 0.5 days to the review deadline (logarithmic), keep sending notices to
   entities with missing reviews
   - If I am an AC: manually remove reviewers that claim that they cannot do it, and add reasonable
     emergency new reviewers
4. When it is −1 / −2 / −4 / −7 days to the review deadline (ie, for overdue reviews), send a serious
   warning
   - If I am an AC, add our Jinesis members directly. Call the public-facing function above on
     paper-to-jinesis-member matching.
   - If I am an SAC, send active messages to nudge AC. If still seriously lacking reviews, let
     Zhijing manually deal with it by personal email nudges to the exact AC's personal email too.

_Partial scaffolding exists in `workflows/papers/openreview-workflow.ts` and `openreview-cadence.ts`
plus the `openreview.nudge` / `openreview.warning` action types; the AC/SAC branch above is not
wired._

## ⬜ zhijing-remind-others-calendar-practice

Template needed: tell that all our calendars should go into `zhij.jin@gmail.com` but not
`zjin@cs.toronto.edu`, which is not linked to Zhijing's calendar app.

## ✅ zhijing-talk-entry

Input: email forwarded to an adminbot address. Output: a line about talk details in my CV, for Andrew
to copy and paste into my overleaf. Starting from the Arian's NeurIPS workshop. Then call
"zhijing-calendar", e.g., output: calendar entry onto my trip's calendar. —
`workflows/cv/digest-doc.ts`

## ✅ zhijing-student-overview

TODO (Andrew): create a spreadsheet/admin view for Zhijing to see everyone's my-profile completed
percentage + timeline entry > 2. — `views/profile-overview.ts`, `workflows/members/adoption.ts`

**Adoption rate tracking** — "Adoption Rate: Who to remind to use AdminBot", prioritizing ICLR.

- ✅ Right now: quick hack of the adoption rate so we know who to chase — difference from the
  spreadsheet and what is present to see who logged anything
- ✅ In 7 days: store timestamp for all logged in (`user_id`, `timestamp`), when the info was updated
  by whom (`slot_id`, `user_id`, `timestamp`)
- ✅ Field update tracking → also log the account that made the update, not the account that was
  updated — `contracts/activity-log.ts` carries `actor_member_id` and `actor_name` alongside a
  separate field for whose record was touched; surfaced by `controllers/recent-edits.ts`
- ✅ Make it people based, not paper based. Log time of edit and person of edit to see who has not yet
  made actions on ICLR (either declare a paper or not declare)
- ✅ Only show the target group for adoption rate, and let the target member types be picked as a
  multiple choice (by default that group + full member) — `ui/src/ui/adminbot/member-type-filter.ts`
- ✅ Remove all members without any emails — `lab_members.purged_without_email`
- 💬 Yenshen Chen: remove the guest account from Slack, and merge the two profiles on adminbot (Lily
  chen). Merging exists (`contracts/member-duplicates.ts`, `lab_member.merged`); this specific pair
  is a manual run.
- 🟡 In this target group, if login time == 0, then trigger slack message reminder

## ⬜ zhijing-location

TODO: "Zhijing-location.csv" about both my IP address location collected from AdminBot and slack time
zone? I need to use it to calculate my days in Canada for later my Canadian naturalization purpose.
You can probably just save the file and keep adding one entry for every day.

_Per-member location history exists (`workflows/members/location-history.ts`); the daily
single-person CSV does not._

---

# FeatureGroup3: People Management Functions

## Member types

Full member:

- Junior vs. senior vs. `prof_and_above`
- Proxy: Zhijing is their main `reference_letter_writer`
- Leads vs. independent contributors
- If Zhijing pays their salary
- If Zhijing is directly checking their weekly progress

## 🤔 (Andrew) Test cases

⬜ Write test cases to check the implementation of all backends for our entire contact list.

- Test by checking whether each access feature has been executed properly after onboarding (google
  calendar, slack, etc.)
- Then confirm with Zhijing on Batch 3 manually
- Then scale up to everyone
- Exclusive condition for our "active" channels — confirm this logic

Specific cases to cover:

1. ⬜ Casual collab for discussions — Folder: XXX; Calendar meeting: XXX; Slack channel
2. ⬜ Not urgent, TODO Andrew: (Level 2) Graduation group: Van, Keenan, Yuen…
3. ⬜ full: Yang Yang (for `#proj-admin-automation`)
4. ⬜ Top 4, Alumni casual collab (Level 3): Yann, David Jenny (Level 3, Items 1,2,3)

## People Flow

### 1. Initial interaction stage

Can you either delete these messages manually, or automatically trigger the instructions for them to
apply through my website?

- 🟡 Type 1: very spam like — let's do (1) manual delete, (2) later, e.g., after Oct 10: allow manual
  forwarding to `jinesis.adminbot@`, and then let it trigger a template reply to let these people
  apply through my website directly. Add in the template something like "do not reply to this
  adminbot email address; state to the sender that nobody will check the responses, and it is only an
  agent sending out template responses, but not any active actions."
- 🟡 Type 2: if they reach out with a concrete project and plausible progress, then you can (1)
  activate "interviewee" status, (2) actively ask them to fill out the application Google form, (3)
  in the slack guest chat, put the tech lead (which means Rahul for Causality and Terry for
  interpretability in the following screenshot)

_`join_form.classify` is a typed action; `workflows/members/applicant-sheet.ts` and
`views/registrations.ts` carry the applicant intake._

### 2. Interview process

✅ On the dashboard there should be a window for the interview process, and three tabs: Applicants,
Interviewing, Trial. Refer to the PeopleFlow Text Templates below for email templates.

- Input: google form (200 responses per 1-2 months)
- Output Step 1: a folder of all the CVs, from the date I have not viewed the profiles
- Output Step 2: trigger the "interviewee" status (10%) — added to applicants tab of the dashboard

**Step 1: Before interview**

- Path 1: Zhijing clicks accept for interview — send email (Interview invite in Text Templates);
  create google calendar invite for whenever free in Zhijing's calendar & timezone; move the
  participant to interviewing section
- Path 2: forwarding it to friend PhDs or Jinesis team leaders
- Path 3: Zhijing delegates interview to a teamlead

**Step 2: Interviewing**

- Zhijing/team lead will have them present their past coding projects, talk about what they did,
  challenges, etc. Also talk about their research interests, and what they want to achieve
- Hidden criteria: gauging the passion, checking the actual implementation process
- If reject, send rejection email
- If accepted, at the end of the interview Zhijing/Teamlead will give them a task that they will do
  over the next 3 weeks, and they will enter the trial phase. Create a google drive folder and share
  with their email, this will be where they place their CV, transcript, progress. They should have
  access to slack contact to Zhijing or interviewing team lead.

**Step 3: Trial**

- At this point the applicant's advancement depends on Zhijing/teamlead's judgement, based on their
  initiative, work quality, etc
- If reject, send rejection email
- If accepted, send an accepted full member email. Full onboarding, look below.

_`workflows/cv/digest-doc.ts` + `cv-scan.ts` cover the CV folder; `contracts/control-ui.ts` and
`views/registrations.ts` cover the three tabs; `auth.registration_approved/rejected` and
`auth.approval_email_sent` cover the outcomes._

### 3. After confirming that they formally join us

**Step 1** — ✅ Andrew & Zhijing send email OR manually enter a list of info (see "input data
structure" described in the access right table below) to the spreadsheet-like interface of the
AdminBot.

- 🟡 Internal review mechanism should be more tolerant (for domains like `@utoronto`), edit email
  template to include name/better formatting
- ✅ Github link of this text template for onboarding. Have a folder of markdown for each template,
  and have the skill read the markdown instead — `extensions/adminbot/skills/adminbot-access-invites`

**Step 2** — ✅ This new full member receives this email, they create a DCS account, and reply to
AdminBot to join the Slack, and create an AdminBot account on the website. —
`workflows/onboarding/dcs-form.ts`

### Step 3: One-shot onboarding

- ⬜ TODO: I would prefer the onboarding steps to be a separate page that tracks what is left to do
  rather than at the end of the "My profile" page. Feels really cluttered right now. _(An onboarding
  checklist component exists — `views/onboarding-checklist.ts` — but it is not its own page.)_
- 🟡 Back-end onboarding for all roles, and front end onboarding for full, major and alumni —
  `workflows/onboarding/member-type-template.ts` carries the per-type templates; the front-end pass
  for those three is still open
- ✅ Data structure: textual name; type `{dropdown list, date, link, one-line short text, paragraph,
numeric}`; order of field display; every field already highly likely has a default value from our
  existing data of the member; saving is instant instead of explicitly pressing the "edit" or "save"
  button; `field_filling_needs`: mandatory and optional
  - If any mandatory field is empty, then the user's dashboard right after login will show warnings:
    "Important fields missing in My Profile: <>, <>, …"
  - Public-to-lab vs. private-to-self: Github, openReview, …
  - Required: linkedin, openreview, and CV
  - Optional: things not on spreadsheet
  - Prefill the "My Profile" with our spreadsheet and our slack. Slack info: `text_str_name`,
    `member_id`, photo, time zone, (optional) `all_channels_they_are_in`

  — `ui/src/ui/adminbot/member-fields.ts`, `autosave.ts`, `workflows/members/member-sheet-grid.ts`

- ✅ Feel free to dismiss any notification on my profile

**Photo tips — 🤔 Professional headshot** — 🟡 (`slack.profile_photo_update` exists; the 30/60-day
escalation loop does not)

Since we're developing some webpages, you're highly recommended to change to a professional profile
photo for your Slack, so we can include you and your photo under the "teams" or "collaborators" page
of our websites. Some principles: big enough headshots like Zhijing's and Angelo's; make sure you
look in the front in the photo; make sure the background is clean enough, either blurred or a single
color. Please keep your slack photo updated, because we will directly link member photos from Slack
on your profiles, and our lab public website.

Should disappear if photo is good enough, run one time on onboarding: if photo is good, finish; else
while photo is not good, check after every 30 days until finishing; elevate to Zhijing's "My
Desk-Nudge area" if this remains a problem after 2 times of warnings (i.e., after 60 days).

- If you are ok with using AI, here is an AI-polished photo using your original slack photo (or your
  public online photos) and following the above style preferences. Early use cases: for Andrew. Todo:
  ask the user "would you like this photo to update your current slack profile?"
- How-To if you want to take a better photo yourself: use portrait mode and back camera higher
  quality, and have somebody taking the photo for you. Sometimes the phone or photo editing apps can
  allow "blur the background" or change the background to a pure color. Some members' photos are just
  taken in 10 seconds from a good phone using the profile mode. Usually neutral backgrounds are
  nicer, so you can upload the photo to https://www.remove.bg/ to crop yourself and put yourself into
  a neutral background. Usually the shot is chest up, and includes shoulders.

**The user themselves fill in all the fields on the website**

- ✅ AdminBot: make them click on it https://linkedin-urn-collector.vercel.app, and then let them fill
  out their linkedin urn on "My Profile". ⬜ Make it run on aurora (based on Samuel's suggestion), and
  make the URN typable so they can copy and paste
- ⬜ 🤔🤔 Should also have a link field, where they can click to edit or update their Google Form
  original response. E.g. their career ambition is pretty important for Zhijing to often retrieve and
  recap.
- ✅ If any key information is missing, send them a reminder every X days
- ✅ Google calendar: add people to our Google Calendar — mandatory lab meetings; optional themed
  meetings later according to the `proj_id` — `workflows/onboarding/calendar-invite.ts`,
  `themed_meeting_invites.swept`
- 🟡 Add them to `#jinesis-active` and `#random-active` `#jinesis-friends-…` channels. Coauthor-major
  and Zhijing's own advisees should also be invited to `#jinesis-active` and `#random-active`.
- ✅ New Field in profile (paragraph text-style): "(Optional) Your medical conditions or your family
  situations that you think Zhijing should know"
- ✅ Timeline function — `views/time-availability.ts`, `time-allocation-chart.ts`

  > Just to make it clear, the timeline function is pretty urgent, having it up within 24 hours would
  > be appreciated! E.G., I really wanted for several members that would help them organize their
  > summer tasks better. Your top users who should use your timeline tool to share with me their time
  > arrangement should be @Kem Nguyen-Le @Pepijn Cobben, @Joeun Yook, Narmeen, David Guzman, Angelo,
  > Arian, Gopal
  - ✅ We also need a dedicated "holiday OR time-off from the jinesis lab due to another career
    arrangement, e.g., busy semester or internship, etc"
  - ✅ (Andrew, Luke) Add feature to attach links (flag as optional, this is for class schedules etc)
  - ✅ Macro timelines — conference submission deadlines, graduation/thesis dates — date object
    - In existing table, people should be able to put in holidays/vacation = default to whole day off
    - Change effort to num hours
    - Possibly smaller table on the side as "big deadlines"
    - Task table = separate to jinesis related and other (including holidays) — holiday overrides
      task duration (holiday, school work, personal time off, out of jinesis projects,
      internship/work). Dropdown list of above list for consistency. Allow manual input for others.
  - ✅ Y axis is still roughly hours — maybe add toggle — currently was %, but we want to change it
    back to hours
  - ✅ Aug 14: add big deadlines per person (above the actual plot); paragraph notes for the whole
    calendar; big deadlines in the main body; add "modify" feature
  - ✅ Enable the alumni declaration — allow them to either do Time Availability "timeoff declaration"
    (we already implemented), or change status to "alumni" with a note field for their
    "Conclusion&Next Step"
  - 🟡 Zhijing wants to also log the timeline of the members, to create a visual like this given their
    workload distribution (20% xxx, 30% yyy, etc.)
  - 💬 Reference from Emilia: here is the copy of my script (Apps Script link), it produces this doc

- ⬜ New field: `if_ETH_thesis` — related: ask them to add thesis deadline; recommend the Guidebook
  section ETH Thesis templates. _(Thesis milestones exist —
  `workflows/members/thesis-milestones.ts` — but no `if_ETH_thesis` field.)_
- ⏳ Force add each member to appropriate Slack channel (based on research interests), and assign
  group names to each member that is a part of that group — 🟡 `workflows/members/topic-channels.ts`,
  `slack.invite_to_channel`. Enabling channel adding according to Column Y is the missing mapping;
  `city-channels.ts` covers the geographic half.
- ✅ If joined month >= 2 months ago, skip (let them fill in themselves, but check the permissions to
  be edit). Otherwise force create and share a template Google drive folder with correct sharing
  access according to the full guidebook. If Drive folder already exists (and is provided), update it
  accordingly. Include a shortcut to Jinesis-share folder. Force add Internal guidebook into the
  folder. — `workflows/onboarding/drive-workspace.ts` copies the lab prototype folder item by item
  and fails loudly rather than provisioning a partial workspace
- ✅ Daily sync on database and member spreadsheet by superset rule (Andrew think on how to merge
  conflicts, maybe don't change if conflict) — `sheet.update_cells`, `api/server.member-sheet.ts`

**Rec Letter Request interface** — ✅ `views/logistics-requests.queue.ts`

- 🟡 "List of Schools": ask Tae to rename to "List of Deadlines", because it can be also to companies
  or fellowship programs instead of schools; test himself as a user; polish wherever he sees
  appropriate
- 💬 Please see our github repo above in the beginning of the doc
- 💬 Example: `grad_app_Keenan`, `grad_app_Changling`
- 🟡 The list of facts can be on the adminbot, everything else can be in the google drive template
- ✅ Hint to make them read the Guidebook — server access section; API-reimbursement steps; if junior,
  "How to ask for Rec Letters"; if junior, important dates; common practice for Google Drive folder;
  messaging protocol to Zhijing; checklist: read through perhaps 5-10 articles of my github repo
  https://github.com/zhijing-jin/nlp-phd-global-equality — `extensions/adminbot/src/guidebook/`
  - ⬜ TODO for admin: we need to brief them our workstyle. This following template is from the Future
    of Life Institute. We should compose our own.
- ⬜ Todo for Admin: continue to improve `Guidebook-minimal-read`
- 💬 Remove GPU onboarding (done on admin side)

### Step 4: Verification from AdminBot

- ✅ Update the `current_city` for each member from their IP address, in addition to slack showing
  their time zones — `connectors/ip-geolocation.ts`
- ⬜ [Interviewee] Check if the login for the website is from chrome (otherwise issue a "warning flag"
  because we support only `cache_saving` function on chrome, to save offline changes)
- ✅ LinkedIn work experience verification / reminder. Remind separately for EuroSafeAI by referring
  to the guidebook's EuroSafeAI membership policy section. For admins: we can manually optionally
  draw a flowchart of Jinesis vs. EuroSafeAI participation decisions.
- ⬜ [Interviewee] X follow verification / reminder
- ✅ Force check: if their openreview is in our record (via website, or spreadsheet), open the URL of
  it to verify whether it exists. If not present, trigger `profile_reminder`. —
  `connectors/openreview.ts`
- ⬜ For every calendar entry on the lab calendar, check if it is set to be "guest can edit" and also
  if a zoom link exists, then the google meet must be disabled. Tell the "organizer" of the event to
  "allow any attendee to edit (there is a global setting for this for google calendar, and also you
  can edit individual events too)" — use images. _(`workflows/calendar/lab-calendar.ts` reads the lab
  calendar; the guest-can-edit audit is not there.)_

### (Aryan) Step 5: After 10 days, and update every 2 months

- ✅ Add to appropriate slack city channel (e.g., `#group-toronto` and `#group-zurich` this type of
  format) if there are more than 3 members in that city, and any relevant public channels according
  to their profile and history / ongoing projects — `workflows/members/city-channels.ts`, which
  resolves "Zürich", "Zurich", "currently Zurich" and `Europe/Zurich` onto one channel using the same
  resolver the member map uses
- ✅ Based on the city, let them read the specific guide on the Guidebook section (link to specific
  subsections): Toronto, Zurich, Tuebingen — `city-channels.ts` returns the guidebook section each
  member needs alongside the channel
  - 💬 Should be behind user approval (do we still need the API if we rely on cookies instead?)
- ⬜ Issue warning if the google drive folder doesn't follow the Common practice
- Always running every few days:
  - ✅ Slack channel addition: all the shared public channels, conference channels, topic-specific
    meeting and discussion channels, `proj-` channels — `project_channels.swept`,
    `topic_channels.swept`
  - ✅ Near thesis deadline: e.g. guidebook section, remind Zhijing grading them after 5 days
    post-submission deadline — `workflows/members/thesis-milestones.ts` emits a `guidance` action
    before the date and a `grading` action once `adminBotThesisGradingDelayDays` (five, as asked)
    have passed
  - ✅ Near graduation deadline: e.g., trigger the "alumni" status confirmation question; host yearly
    graduation ceremony — `workflows/members/graduation.ts`, where the date is member-editable but
    the alumni transition is admin-only because it has access consequences
- ✅ Alumni: send Slack invite after 10 days instead of immediate — `alumni_slack_invites.swept`

Search "Definition of the reminder trigger" above.

### Step 6: After 30 days

1. ⬜ Input: 1 new internal or external member, but wants to interact with our other (N−1) existing
   members fully. Output: recommended papers from Jinesis, and recommended top 5 people to talk to (&
   very brief suggested reasons).
   - Every person's profile info on our portal is used, as well as their public website's content, CV
     (whose PDF link is provided in their profile too), etc.
   - (yang yang) Make a function similar to the "AI recommendations" for top Jinesis members to chat
     1:1 with each other, or form project collaborations.
     - Make this modular: 1. adminbot database, 2. google form responses (that they link it), CV (ex.
       if someone has done an internship at google, they could be matched), public presence (ex.
       linkedin, google search, google scholar — ex. if they co-authored with zhijing)
     - Maybe not RAG, could use cosine similarity with strings and recommend the most similar people
       (for the interests at least)
   - _(`connectors/embeddings.ts` exists and is used for paper/workshop matching; the person-to-person
     recommender is not built.)_
2. ⬜ Flag violation of `user_type` automata graph: for admins to review
   - ✅ Admin view of who is missing on their My profile, especially timeline related nudging
   - For papers: teach people that the google drive url link does not change when you change
     permissions, and can have suffix `#tab…` and `#heading=…`
   - Make it multiple choices allowed
3. ⬜ Trigger "FeatureGroup5: Lab sharing info"
4. ✅ Students can keep using functions like "My Profile", "My Papers", and "General Tools"
5. 🟡 [Zaryab] Weekly check
   - Monday attendance-taking & Wed themed meeting attendance-taking. Output: a continuously
     increasing google doc, whose top page is always the most recent meeting, and the list of missing
     members (e.g., if taking attendance at the 15min-past-the-starting-time). Later function:
     elevate to Zhijing a list of people who have not attended the meetings continuously. She will
     decide if we need to manually catch up with people.
   - {Implementation} User flow: 1. user connects their Zoom and Google accounts through OAuth; 2.
     user selects a date; 3. backend retrieves Zoom meetings conducted on that date and displays the
     available meetings; 4. user selects a meeting; 5. backend retrieves the meeting's
     attendance/participant report from Zoom, the corresponding Google Calendar event using the Zoom
     meeting ID/link, and the Google Calendar RSVP status; 6. backend merges the two datasets into a
     combined CSV for the user to download with fields: Name, Email, RSVP, Joined?
   - Constraint: since the zoom account is academic (`utoronto.edu`) with possibly
     zoom-for-developers not enabled/allowed, will have to use OAuth authentication.
   - _Status: `workflows/meetings/attendance.ts` parses a host-exported participant CSV from a watched
     folder and lines it up against the roster, with the transcript as a weaker second source
     (`vtt.ts`) that only ever pre-ticks a roster an admin then corrects. The Zoom OAuth path and the
     report endpoint above are the gap — the file says so itself._
6. ⬜ When 3 months into our lab
   - Every 3-month reflection point: nudge people to send their self-reflections with Zhijing on
     slack
   - Prompt on their user interface to check if they need Immigration advice: Canadian PR (they can
     check Aly's doc); Europe related naturalization (let them enter their descriptions and self plan
     as a free-text paragraph field on their "My Profile": early users = Rahul, Joeun, Arian); US
     green card
7. ✅ Enable this function on their profile during their job hunting or grad school application time
   - Student front end: add a tab "Logistics request with Zhijing". Under the tab, allow two
     functions: (1) request a signature on your PDF (Andrew, can you add your google form submission
     link here?), and (2) request recommendation letters
   - 🟡 For rec letter request: it should be largely gray before they are 4 months into the lab; and
     then black and fully engaging + giving active advice when they are 4 months in OR the common
     deadlines are closer. Zhijing sees applicants, user sees their own application.
   - 🟡 Editable link to their CV overleaf — so make sure user attaches their overleaf CV to the
     application form for request; source from their profile, have a button for "create application
     bundle". (Optional) Heavy mentoring for their CV: we need to (1) enable the PaperMentor to check
     and give CV prototype + suggestions, and (2) let them always share the editable and also
     readable links of their CV on overleaf / google docs in their PersonProfile.
   - 🟡 We need a folder link for their `grad_app_xxx`, connected with badge function — so we have
     more background of what the person actually did
8. ✅ (Zaryab) Implementing the badge functions on our website — this is for people to align the tasks
   they do in Jinesis with their outcome goals — `contracts/badges.ts`, `views/badges.ts`; badges
   also appear under My Profile
   - TODO: implement these designs
   - Causality badges: Level 1 — scoring a "pass" on CausalTutor curriculum; Level 2 — causal
     researcher, with at least one main conference publication; Level 3 — causal expert, with >=3
     causality papers
   - 🟡 User stats summary boards to encourage interactions: (1) user-only front-end, and (2) lab
     public leaderboard, e.g., the invited talk leaderboard
   - Early use cases: game theory badge — Lily should have it
9. (Yara) If they are Zhijing's PhD or co-supervised PhD:
   - ⬜ Add a field: "do you want to keep in loop with diversity-specific resources, e.g., usually for
     minority groups including women or people from underrepresented groups"?
   - 🟡 If they are not men, then recommend Rising Star application deadlines. Input: find the
     application deadlines and website of all the Rising Star programs (at least the three on my CV).
     Output: (1) add this as a reminder function (60 days in advance, with a 30 days in advance
     reminder) on slack + email for any members from underrepresented groups that fit the eligibility
     of the Rising Star applications; (2) add these application opportunities on my
     nlp-global-equality github readme page of the "Faculty job market" related section. _(The
     opportunities board already carries a `rising_stars` category — `contracts/opportunities.ts`,
     `views/opportunities.ts`. What is missing is the targeted 60/30-day reminder to eligible
     members.)_
   - ⬜ Make it general for any other fellowship / scholarship / travel fund application reminders
   - Early use cases: Angana needs to be reminded of Rising Star deadlines
   - ⬜ Direct email/calendar invite of the last hour of this application deadline on
     `jinesis.lab@gmail` calendar, together with this student
10. ✅ Create graduation events yearly — ask people to fill out the graduation column "C" of the
    contact spreadsheet — `workflows/members/graduation.ts`
11. ⬜ "Active" status for a member `[Not urgent]` — this later should trigger Zhijing's moderation on
    whether we send the disappearing author template
    - Remove outdated members out of `group-zurich` and `group-toronto` etc. Add only, as it is hard
      to tell who is traveling vs moved away
    - Remove any non-full member out of our calendar. Remove any non-full non-major people out of our
      big Monday meeting

## Levels of external collaborator access

### Design spirit

3 most common user types:

1. For their paper, they are collaborating with us in 40+ hours/week capacity, e.g., first author
2. 20 hours/week, mid-author equivalent contribution, not primarily with us. No need to keep track of
   personal life, travel expenses, etc.
3. 2 meetings per paper, but still authorship. E.g., professors giving advice, or peers or anyone
   helping to shape the paper. Trigger emails according to the PaperFlow: explaining targeted
   deadlines, conferences, workshops.

### 🤔 (Andrew) TODO: Users to onboard in each group

- ⬜ External-prof: Ms. Dr. Yang Yang from Geneva United Nations refugee Center, and her supervisor
  Grace
- ⬜ Interviewee: topic: law to benchmark. Collaborator: Kem and Zhijing.
- ⬜ Yann: coauthor-minor style for "EU AI Bench (Oct ARR): {Tae\*, [Wilber, Pranav], {Kem, Yann},
  Zhijing}." But coauthor-major for `#proj-xxxx`.

### Implementation — ✅ `workflows/members/collaborator-subgroups.ts`

Input data structure: email; which project; optional first name and last name; optional which
collaborators they can chat with.

Role overlap rules:

- Interviewee can progress into `{*coauthor*}` roles
- Alumni can go back to `{*coauthor*}` roles, or progress into `{external-prof}`

Access right design for each external subgroup: ✅ _Jinesis Contact/Paper list with Zhijing_. Automata
for user status.

- ⬜ Make coauthor minor common practice doc
- ⬜ Slightly-better-than-email and external-prof gets the same template just talking about they're
  added to slack

### 🤔 (Andrew) Pending requests for (1) timeline and (2) member status update

Two live requests are recorded in the source doc verbatim: a vacation/time-off declaration for August
10–21 (a fasting retreat), and Yann Billeter's 2026-08-07 note on work organisation — looking for a
student for the nowcasting project via DISCO, the VoteSim/GoveSim discussion with David J. and David
GP., combining this with the "slowly moving" social sciences and the Digital Twins work, hosting
students at KOF and DISCO, the SwissAI large project proposal with Terry, interest in the
post-training work with Ryan, coordinating with Kem on the mapping project, and support on policy
issues given enough lead time.

Both are 💬 — they are inputs to the timeline and member-status features above, not features
themselves.

---

# FeatureGroup4: Paper management functions

## 🤔 Pending requests

1. 💬 Make sure Emanuel's many projects (about 3) are updated on My Projects
2. 🟡 We need proj-to-theme mapping for our lab pitch
   - User inputs "alias" (`#proj-causcibench`)
   - User inputs "start date of the project" — then adminbot backend composes the uniq id
     `yyyymmdd-01` or `yyyymmdd-13`
   - User inputs "end date of the project"
   - Lastly, Zhijing reads all the `#proj-xxx` list, and matches them to the `#meeting-xxx` group
     names. One-to-many mapping.
   - ⬜ Given projects, try to propagate column V
3. 💬 By nudge, this "CauSciBench: Evaluating LLM Causal Inference for Scientific Research. Paper
   Link" should be pushed to arXiv
4. 🟡 We need research report compilation to our funders or affiliated institutes —
   `views/grant-report.ts`, `docs/grant-report-track-record.md`
   - ⬜ Grant report compilation (15 hours sprint). Task 1: map all our papers in your `papers_tab` of
     the contact spreadsheet to each of these areas Pepijn wrote. Task 2: add a "track record"
     section for each subsubsubsection of `20260812_EuroSafeAI_proposal` to cG by the format: _Our
     track record on this topic: 1. (EMNLP 2026) Linear Probe xxx. Vedant et al. URL; 2. (ICLR 2026)
     title. Author et al. URL; 3. …_ You can first make a dedicated doc draft, Zhijing can review,
     and Pepijn can insert into each subsubsection by copy-pasting.
5. ⬜ Prof. Roland should be an email-based collaborator to frequently synchronize with
6. ✅ ICLR pre registration view — `ui/src/ui/adminbot/pre-registration.ts`, `prereg.nudged`
7. ✅ First few steps until PDF doesn't get nudged
8. ⬜ Google drive folder assistant: verify people's notetaking habit and give suggestions of sections
   and hierarchy

Do-ers (from the most to the least): Andrew, Joeun. Main advice-givers: Zhijing, Rahul, …

Text notes of the collaboration format: @David Guzman can give timely guidance and suggestions (e.g.,
fast message reply, 2-day-in-advance meeting request) to this team! Main do-ers: @lily, @Jordan Shao,
@Bryan Liu. All the rest of us give asynchronous suggestions via messages + talk face-to-face in our
Wed multi agent meeting.

## 🤔 (Joeun) back-end data structure for papers

TODO: please design a google sheet object, which we can use as our backend.

- Paper id or project id: backend id `yyyymmdd-index`, e.g., `20260805-05` (uniq); associated alias
  `proj-tamperbench`

_Status: 🟡 — the backend is SQLite plus a sheet sync (`sheet.update_cells`), and the paper record
lives in `contracts/paper-slots.ts` / `paper-cycle.ts`. The doc carries an "incomplete and outdated
past example" table whose columns are: Year, Title, Venue, Under Review, Note, personal notes,
Honors, Authors, Authors_Mentees, LaTeX, Paper overleaf, file_name, password, Code, project_website,
Data, Slides, Video, topic, Poster, twitter_draft, Twitter Thread, linkedin_url, video_length,
website_honor, custom1_name/url, custom2_name/url, Contribution statement._

## Main functions

1. 🟡 Overleaf queue, and ICLR pre-registration — `connectors/overleaf.ts`,
   `workflows/papers/overleaf-editing.ts`
2. 🟡 Conference travel organization — social media drafting for papers, queue and mass-action
3. 🟡 After conference results, trigger a bunch of things
4. ✅ Conference results step — input: csv (conference title, openreview link, deadline to announce
   results). Output: update proj info in our AdminBot. Task division: Joeun can click and do the
   EMNLP update, while making the code general. Andrew can do the scheduling. —
   `views/conference-papers.ts`, `workflows/papers/openreview-workflow.ts`

**Urgent Paper flow fixes**

- ✅ My papers auto save — `ui/src/ui/adminbot/autosave.ts`
- 🟡 Spreadsheet view → sync with the card view fields — `paper-grid.ts` and the card dialog share
  `paper-columns.ts`; confirm the two agree field-for-field
- ✅ Allow import of other spreadsheet → LLM → store information in backend —
  `workflows/papers/import-columns.ts`, `ui/src/ui/adminbot/paper-import.ts`
- ✅ Allow "email all (Jinesis) coauthors of this project" — `ui/src/ui/adminbot/coauthor-email.ts`

## ✅ Paper Flow

`contracts/paperflow-stages.ts`, `workflows/papers/paperflow-stages.ts`,
`ui/src/ui/adminbot/paperflow-map.ts`, `views/paper-timeline.ts`

Paper dependencies:

- Brainstorming (Google Docs) → Overleaf writing (view only and edit links) → Unofficial Google Drive
  link → Submit to a conference → Rebuttal → Publish on arXiv → Social media post
- Submit to a conference → Slides
- Compose a "Gantt chart"
- Early use cases: automate all future things like this

### 1. Brainstorming

Start every paper with a Google Doc for brainstorming and put it in your shared 1:1 Google Drive
folder with Zhijing. Name it using `YYYYMMDD Project_Name Brainstorming`, for example
`20260808 Your_Project Brainstorming`. Use this as the central document for the initial idea,
research questions, experiment plans, potential datasets/models, collaborators, meeting notes and
possible target venues. Give or register the brainstorming document with AdminBot; AdminBot should
store the link, check the naming convention and folder location where possible, and initialize a
persistent paper/project record that will be used throughout the entire workflow.

### 2. Overleaf Writing

Once the idea develops into a paper, download the official template for the current target conference
and create the paper in Overleaf with the basic section structure. Register both a view-only link for
Zhijing, lab members, and other readers, and an edit link for active coauthors. The student should
provide these two links and the current target venue to AdminBot. AdminBot should store and
distinguish the two links, make the appropriate link easily retrievable whenever someone asks for the
paper, associate the paper with its target venue, and fetch or store important conference deadlines
where possible.

_Note: 3–7 can be mixed in order._

### 3. Conference Submission

Submit the paper to the selected conference, workshop, or ARR cycle and immediately register the
submission rather than leaving the information only inside the first author's conference account. The
student should give AdminBot the venue, submission ID/link, track if applicable, and ARR cycle or
commitment venue when relevant. AdminBot should store the submission attempt under the existing paper
record, fetch relevant conference dates and status where possible, mark the paper as submitted, and
begin tracking the next dependencies such as reviews, rebuttal, decision, and presentation
preparation.

### 4. Internal Google Drive PDF

Before the paper is publicly available on arXiv, compile a stable version from Overleaf and put the
PDF in the appropriate shared Google Drive folder for informal distribution within the lab. This
should be the convenient version for Zhijing, coauthors, and trusted internal readers to read or
circulate while the work is still non-public. Give the Drive PDF link to AdminBot. AdminBot should
store and surface the latest internal version and clearly distinguish it from the live Overleaf
draft, the conference submitted version, and the later public arXiv version.

### 5. Reviews and Rebuttal

When reviews are released, read all reviews, organize the major criticisms and questions, and prepare
the rebuttal or author response if the venue provides one. By default first author drafts rebuttals,
and shares the rebuttal document to coauthors / AdminBot when applicable. Also if integrations such
as OpenReview allow it, AdminBot should fetch review availability and relevant review/submission
metadata automatically, track the rebuttal deadline, notify the authors that reviews have arrived,
and record whether the response has been completed and submitted. + Guide how to write rebuttal based
on guidebook.

### 6. Slides / Poster

Conference submission also creates a parallel presentation material workflow. Prepare slides, posters
with the final required format. Register the slides and poster links with AdminBot as they are
created. AdminBot should associate these materials with the existing paper record, fetch and surface
the latest slides/poster/video from the shared folder, and make them easily retrievable later so
Zhijing or other lab members do not need to ask individual authors to find and resend them.

### 7. Conference Decision and Resubmission

When the conference decision arrives, record it in the existing paper record. If the paper is
accepted, proceed toward camera-ready preparation, presentation materials, arXiv, and public
communication. If the paper is rejected, return to the Overleaf writing stage, revise the same paper,
choose a new venue, and submit again. A rejection should not create a new paper/project record.
AdminBot should preserve all previous submission attempts, reviews, rebuttals, and decisions so the
complete history of the paper remains accessible while a new submission attempt is added.

### 8. Camera Ready / Public Version

After acceptance, prepare the camera-ready version required by the conference. Alternatively,
regardless of the conference result, the authors may decide that a sufficiently mature preprint is
ready to become public. In either situation, **always get Zhijing's explicit Yes before publishing
the paper on arXiv.** The student should provide or confirm the intended public version and approval
to AdminBot. AdminBot should record this approval as a required gate and should not consider the
paper cleared for public release until Zhijing's explicit approval has been recorded.

### 9. arXiv

Once Zhijing has explicitly approved the public version, publish the paper on arXiv and register the
resulting arXiv URL/ID with AdminBot. The arXiv version should then become the canonical public paper
link used for external distribution. AdminBot should store the arXiv metadata, mark the paper as
publicly released, and use the arXiv link rather than the internal Google Drive PDF for subsequent
public facing workflows. [This will be very helpful for social media as well.]

### 10. Social Media Post

After the paper is public, use AdminBot's social-media function to draft the LinkedIn and Twitter/X
announcement. AdminBot should use the information already stored in the paper record, such as the
title, authors, abstract/contribution, venue information, and arXiv link, to generate the draft and
include the correct public link and author information where available. The responsible author should
review and edit the generated post before explicitly approving publication; AdminBot should only
perform any supported public-posting action after this approval.

### Notes

- 🟡 Optionally collect google drive file / folder for the paper
- ✅ Mandatory: Overleaf link filling section
- ⬜ Include a section in guidebook on writing a draft
- ✅ In paper stage: "Your Current Stage of the Project:", showing your current stage; all the nodes
  that have been finished thus far; "Next step that you can start doing:"; "Waiting for:" someone's
  review — e.g., click "nudge Zhijing to give review" — `ui/src/ui/adminbot/next-step.ts`,
  `blockers.ts`

### ✅ Nudger logic

`workflows/papers/paperflow-stages.ts`, `paperflow_stages.nudged`

- A. Model the workflow as a DAG of actionable nodes and predecessor / successor dependencies.
  Exception in DAG structure occurs only in two cases: paper rejected; Zhijing says not yet for
  archival.
- B. Keep the nudger stateless and read node completion status directly from the backend.
- C. Nudge only frontier nodes: incomplete nodes whose predecessors are all complete.
- D. For blocked tasks, traverse upstream to identify and nudge the actual actionable dependency.
- E. Route nudges based on dependency type, including missing predecessors, approval gates, and newly
  unblocked successors.

### Other paper-management items

2. ✅ [Zaryab] Let's maybe have a general function to suggest certain channel naming? (see our
   guidebook Slack Naming Rules). PR: https://github.com/akhkim/openclaw-adminbot-lab/pull/18
   - Action 1: remind the owner of the channel to rename according to the rule
   - Action 2: if no action was done in 48 hours, then we directly rename the channel + tell the
     owner why we are doing the change
   - Use cases: `the-rule-coherence-project` is an invalid naming. Also `eu-post-training` is a real
     naming, as it should be a `proj-` or `meeting-` type given the advice on our guidebook

   — `slack.channel_naming_notify_owner`, `slack.rename_channel`

3. 💬 Default: a single person is the coder; all the rest are discussants. Alternative: please state
   very clearly who does what, in your overleaf Ack section.
4. 💬 Check out Samuel's AI coding agent
5. ⬜ Make some tools very friendly for travel and holidays
6. ⬜ Project takeover for retired-member of the lab or of the project — to confirm their
   disappearance status and type of delegation they allow us: Van for the lab, Andrei for the
   wordplay project
7. ✅ Conference submission suggestions — sweep through all the conference deadlines and workshop
   deadlines (major). Workshop deadlines are swept every day when the deadline is under 3 days out;
   conferences every 2 weeks.
   - Archival: ACL/EMNLP/NAACL main and demo, and then NeurIPS/ICML/ICLR/COLM/CLeaR. Ideally no more.
     (see the guidebook section)
   - Non-archival: also include IASEAI non-archival submission. Also include EACL/AACL main and demo,
     which is archival, but only secondary for us (as they are less competitive than the above
     batch). Workshops of ACL/EMNLP/NAACL/EACL and NeurIPS/ICML/ICLR/COLM. ARR conferences:
     `submission_type1=direct submission`, `submission_type2=commitment_deadlines` (feasible for any
     papers with an ARR review).
   - Output 0: a more customized deadline count-down website for all the above venues
     (aideadlines.org; https://jinesis-admin.vercel.app/adminbot/deadlines)
   - Output 1: reminder to the `jinesis-active` channel. By default archival venues, or a list of
     non-archival ones suggested by Zhijing & Terry: IASEAI non-archival
   - Output 2: customized Slack message to keep reminding them (logarithmically, 30 days before, and
     then 15 / 7 / 3 / 2 / 1 days before) until Zhijing's open review shows the submission entry.
     Else, elevate to Zhijing. Matching of 20 workshops per conference to ongoing papers, or ready
     papers from (CurrentYear − 1) to now.
   - ⬜ If a withdrawal is needed, both add this suggestion to the guidebook, and also use Zhijing's
     own accounts to check and tell people which submission needs to be withdrawn to avoid "dual
     submission" for archival venues
   - ⬜ ddl of NeurIPS workshops: improve the nudge implementation by giving a human touch and also
     allow elevation to Zhijing (remove conference submission guide check). Check diff between
     OpenReview's submission list for next workshop and private spreadsheet, find all XX domain
     papers, send a message to the first authors to submit to Blackbox NLP (assume Damiano does
     matching). Buffer the NeurIPS suggestions: (workshop title, paper title, author name to send
     nudge to).
   - 🟡 Paper to workshop matching → use call for papers + a few paper titles in the prompt, parallel
     API calls to speed it up — `workflows/papers/workshop-match-llm.ts`, which caps parallelism with
     `maxConcurrentRequests`
8. ⬜ To Zhijing & Terry only — input: all the above conferences' "call for tutorial" openings and
   deadlines; some grant websites https://aisafety.com/funding. Output: enrich the deadline tracker
   spreadsheet AND send slack messages to Zhijing & Terry in a joint chat.
9. ✅ On the openreview portal, never list Zhijing as a reviewer. Always exempt Bernhard as
   unavailable at all. — `openreview.warning`, `connectors/openreview-notes.ts`
   - Auto-check and slack-message or email the first author, or first two if the second author is
     also a Jinesis member but not prof. We probably needed this ASAP for any recent submissions or
     soon-to-come ones, or various workshop submissions. E.G., maybe the function should be that
     whenever on my profile any submission was generated or modified, we automatically check and
     immediately warn the first two authors for this (on both slack and WhatsApp).
   - Policy: our lab policy is that I should never be listed as a reviewer, but if any coauthor group
     accidentally listed me, they should handle the reviews after one of our admins (including you)
     forward them the reviewing paper PDF and rubrics. They should be responsible for their own paper
     reviewing cycle or penalties resulting from this.
10. 🟡 When submitting, take care of anonymity
11. ⬜ Additional: "surprise paper" trigger
    - Topic matched with Zhijing's website-stated interest or commonly published topic && member for
      at least 3 months of 20+ hours of first-author work && no national security risks (i.e., no
      sanctioned countries including China or institutions in the coauthor field AND no such
      connection or such funding sources in the acknowledgement section): Yes. Else: no.
    - Unit tests: no to vision papers. Yes to interp + main members of the lab.
    - Improve this Decline template: _thank you again for sharing! This is a nice paper.
      Unfortunately, since I'm not involved in the making process of these papers, please refrain
      from adding me as a co-author without asking in advance and giving me sufficient time to put
      significant direction-shaping contributions to your work. Otherwise, our lab does not lack any
      papers to have my name on but with no contribution from me._
12. 🟡 After every paper deadline, update all the papers in Zhijing's openreview account into our
    `paper_backend_sheet`, hopefully a Google spreadsheet so it's easier for us to edit
13. 🟡 Conference attendance training — if first author or co-first author, then trigger all the
    following: must read reimbursement policy in the guidebook; register for conference, book flight,
    airbnb or hotel; create or join the conference slack channel, format `#conf-icml-2026`;
    (optional, but suggested) coordinate with members for shared flight time and Airbnb, so the
    conference can also serve as a teambuilding opportunity. Early user: Memo (for COLM). Use
    _Jinesis Lab: Quick Pointers of Research in 2026_ extensively.
14. 🟡 After conference: trigger reimbursement reminders

## Social Media tips

- Example 1: Owain Evans
- Example 2: Yilun Du

> Re Owain's Twitter game, I don't think there's anything mysterious. He has 20k followers, which is
> about 2-3x what I got up to back when I was tweeting once every 1-2 weeks (2017-2019 or so). And
> his tweets seem to have about 2x the number of likes compared to similar ones I posted. He's been
> at it longer, and maybe also has a bit more time for tweeting since research is his only
> responsibility. It seems like he's mostly tweeting when something happens that gives him a reason
> to, like threads for new papers, announcements of job openings, etc. (I probably remembered to
> tweet like 1/3 to 1/2 of the time. Maybe he does it more consistently.)
>
> His work lends itself nicely to tweet threads since the core messages are fairly easy to explain.
> The amount of engagement he gets is probably mostly downstream of his stature in the AI safety
> community. You could follow the same strategy pretty easily, right? Just have your students draft
> polished threads for every paper release, which might add like an hour of editing work per paper.
> And otherwise just say nice things about work you like. Maybe it's like 1 hour of extra work per
> week and boosts your visibility by 5%?
>
> We can work on ways to put the bottom line up front.
>
> I see you put the link in the top-level tweet, which makes it get penalized by the algorithm. That
> might have reduced the engagement. But also, there's a difference in topics which probably explains
> most of the gap. Owain tends to tweet discoveries about how LLMs work, which are of pretty broad
> interest. "Here's a new benchmark" is of interest mostly to people who would have a reason to
> benchmark that thing, like regulators, company safety researchers, or other researchers in the
> area. So it's just a smaller audience.
>
> But the important thing for the benchmarks is that they have visibility to the people who might
> actually want to use them or follow the results, and I imagine you're already doing pretty well on
> that.

## Data structure for submitted papers

- Function: whether to commit — 🟡
- Function: teaching people how to do rebuttal — ⬜
- For venue selection, refer to this: https://venue-picker.vercel.app/

> For the commit and rebuttal stages, the Guidebook's Rebuttal Writing Tips section already explains
> the process well. What AdminBot could add is a more number-based decision guide by gradually
> collecting scores and outcomes. For ARR reviews, decisions depend on many factors and often require
> long explanations and case-by-case judgment. Instead of trying to make the decision itself,
> AdminBot can simply show relevant past use cases.

- Use case 1: for example, have a record of — Paper X received scores of 2, 4, and 5 and was rejected
  from NeurIPS. The same paper was later resubmitted to ICLR, received 4, 6, and 6, and was accepted.
  These cases can help provide rough numerical context rather than a deterministic prediction.
- Use case 2: for the EMNLP committed papers that Zhijing reviews as an SAC, among 45 papers, one
  paper got a meta review of 4. 8 papers got 3.5. Storing data from both (1) our papers' internal
  results and (2) the rough score distributions of committed/submitted papers that Zhijing can see
  through SAC/AC visibility could help AdminBot provide useful numerical context.
- Use case 3: for rebuttals, AdminBot could provide examples of common weaknesses raised by reviewers
  in certain topics and examples of successful responses. Across meetings, I have seen several people
  discuss issues such as sample size, LLM-as-a-judge reliability, and human consistency.
  HistoricalRevisionism paper had a good example of improving the score with quite low effort
  rebuttal changes. The rebuttal section could therefore include an FAQ of common reviewer concerns,
  along with real examples of rebuttals that successfully addressed them.

### Data structure

- `paper_id` (we can use the first openreview id of the paper)
- `submission_obj`: `first_date_of_entry`; `venue: {"ARR", …}`;
  `commit_venue: {None, "EMNLP", "ACL", "EACL", …}`; `next_ddl: yyyy-mm-dd`;
  `action: {"no_action", "nudge_author", "urgent_alert_author"}`; `last_date_of_change`;
  `weekly_meeting`; `openreview_obj: {}`

## Lifecycle of lab announcements

1. 💬 Manual task: Zhijing's linkedin — two summer schools (Multi-agent, MLSS), MARS mentorship talk
2. 🟡 Every 4 months: newsletter compilation — `buildNewsletterDraft` in `cv-scan.ts` composes the
   draft from detected CV changes; the four-month cadence and the trigger around it are the gap
3. 🟡 Report to CG and other funders — Acceleration Consortium; complete the questionnaire in support
   of the Acceleration Consortium's Canada First Research Excellence Fund (CFREF) Year 3 Report. As
   noted in the message below, this mandatory report captures the progress and impact of the
   Acceleration Consortium and is a requirement of the CFREF program. Your responses are essential
   for tracking key AC metrics and for highlighting the important work and successes across our
   community. Extended deadline: August 7, 2026.
4. ✅ Every conference notification date: send acceptances to all our mailing lists —
   `views/mailing-list.ts`, `workflows/papers/mailing-list-email.ts`, `publication-list.ts`. The list
   is selected by time range and target email.
   - 🟡 By conference acceptance, not all papers written

## PaperMentor 2.0

⬜ — referenced from the paper checklist (`contracts/paper-slots.ts`, "PaperMentor review done") but
not implemented here.

1. Check there is no national security risk (i.e., no sanctioned countries including China or
   institutions in the coauthor field AND no such connection or such funding sources in the
   acknowledgement section): otherwise message the student to force-remove Zhijing and Bernhard, and
   also do such changes on the overleaf.
2. Add acknowledgment to PaperMentor (cite) and AdminBot (cite). Accumulate and improve our Jinesis
   own papers' bibTeX.
3. Nudge citations of Jinesis existing papers; nudge the authors to read our papers in their project
   devising stage too, and suggest people to talk to given each other's skill sets and past paper
   profiles.
4. Implement this check as a mandatory; or directly force-fix on overleaf :).
5. Often there are cases when people want to bring up more co-authors — my only constraint is that
   any co-authors cannot have Chinese affiliations, due to national security policy at the Max Planck
   Institute; and also there should be absolutely no funding in the acknowledgment section from
   Chinese sources or related ones from sanctioned institutes.
6. Improving certain sections
   - Andrew: affiliation improvement
   - Andrew: dataset section (Sec 4.1 or so for a standard paper) improvement. _"We train the model
     on MARCO (cite), one of the most popular (reason of choice) question-answering datasets (nature
     of dataset) containing 40,000 query and response pairs (size and each sample composition) from
     Microsoft Bing search and curated results (source and topic)."_ Causal AI Scientist needs to
     describe CauSciBench in its Sec 4.1.
   - Todo for Memo: improve the `conclusion.md` — Sentence 1: surface-level introduction to the
     method (We present…); Sentence 2: show the improvements (Empirically,…); Sentence \_: future
     work
7. Paper skeleton (`\section`, `\subsection`, `\paragraph`)
   - Section 1. Intro
   - Section 2. Task Formulation or Problem Setup
   - Section 3. Method — highly prefer `\subsection{}` over `\paragraph{}`; give method names, and
     tell the nature of the method by buzzwords (multi-agent, AI for Science, tool-use); highlight
     reliability a lot; quote block: thought experiment — you are using it to analyze high-stakes
     decision-making data, the policymaker needs to inspect the solidity of the step-by-step
     reasoning of the model
   - Section 4. Experimental Setup — `\subsection{Datasets}`, `\subsection{Model Selection}`,
     `\subsection{Implementation Details}`
   - Section 5. Results / Experimental Results — Overview, `\subsection{RQ1: …}`,
     `\subsection{RQ2: …}`
   - Section −2. Related Work
   - Section −1. Conclusion — if standard, follow structure, otherwise make exceptions
8. ARR PaperMentor 2.0 (Oct submission to ARR) — describing baselines: Claude-Opus/Fable writes a lab
   report, and downplays the results. Sonnet is better, but still bad.

---

# FeatureGroup5: Lab sharing info

**The whole tab is frontend-only mock data today.** `ui/src/ui/adminbot/views/lab-sharing.ts` says so
in its own header, and seven `MOCK_*` constants back every panel on the page. The panels below are
rendered; none of them read real state.

1. 🟡 Zhijing lab-wide status sharing
   - Show only Zhijing's time zone but not `current_city` (from slack)
   - Last slack full check date: 2026-Aug-06 (manual by Zhijing)
   - Email progress bar: only 10% done
   - Overleaf progress bar: only 10% done from all the pending papers
   - Focus in the upcoming 7 days: mostly AdminBot team, and 1:1 catchup with some students in the
     queue
2. ⬜ 🤔 (Andrew) Org Chart to understand our leads and admins. Todo: we also need to specify the
   roles for all institute admins (see our guidebook for Nini, Gizelda, Sabrina, etc)
   - This helps the ChatBot function: "Who to ask if I need XXX, or want to do XXX"
   - E.g., reimburse API costs, …
   - Google doc or slide, html, etc.
   - E.g., Andrew takes charge of: lab email management; financial cost coordination with Gizelda and
     TD bank; slide making support; meeting and calendar management; well-defined admin tasks with a
     clear description and action steps
3. ⬜ Update the overall visuals of every member and their topics. Update the lab slide page; other
   linked ones (where we put the top members). We automatically add people to the EuroSafeAI People
   website, and some jinesis website page.
4. 🟡 Update our student achievements summary (for Newsletters; or demonstrating our alumni
   achievements) by their linkedin page changes — see `cv-scan.ts` under
   [FeatureGroup1 item 6](#6--acquire-from-han-student-achievements-summary)
5. 🟡 Generating derivatives from our contact sheet & SQL backend
   - To Daniel@Vector: list of people with access to vector and whether their access should be
     renewed
   - To Eugenia: on our latest user list for servers
   - ✅ Mailing list update of our new publications
6. ✅ Member Location map: public website function, showing a map for Jinesis members — visualize
   where all the Jinesis members are, according to our `current_city` info from AdminBot website, or
   slack profile last active location, and refresh every day. — `views/member-map.ts`
7. ✅ Slack channel naming convention safeguarding — from paper acceptances in "FeatureGroup4 Paper
   management", also auto-create `conf-xxx-20xx` channels for anything in the upcoming 12 months
8. 🟡 Mailing list broadcasting — To MPI to Kateryna: Conference papers and publications 📚

   > For every submitted, accepted, or rejected paper (or publication), please send an email to
   > Kateryna with the publication details and cc Karin Bierig. This will allow Kateryna to keep
   > track of the department's publication statistics, while Karin can update the publications on the
   > MPI-IS website. Title, author list, paper pdf link is appreciated, venue, status.

9. ✅ Meeting recordings — the archive links out to the unlisted YouTube playlist and names
   `#jinesis-share` as where recordings are posted and discussed (`views/meetings.ts`). The link is
   guarded so a deployment that blanks the URL ships no dead button; unlisted rather than private,
   because the link is the access control and the tab is already behind a login.
10. ⬜ EMNLP overview post — LinkedIn compilation; CG proposal update: our track records; automated
    mailing list update

---

# Text Templates

Link to github folder: `openclaw-adminbot/extensions/adminbot/src/onboarding-emails.ts` (Refactor to
refer to templates instead?) — ✅ done: templates now live as markdown under
`extensions/adminbot/skills/adminbot-access-invites`, and the sender is
`workflows/onboarding/emails.ts`.

By David: `20260807 _ External-Prof Email Templates`.

⬜ **Some user roles do not have Email templates.**

## Data structure of the template

```ts
{
  id: "slightly_better_than_emails",
  kind: "subgroup",
  subject: `Collaborating with us on {project_or_context}`,
  required: [
    "contact_name",
    "deliverable",
    "first_name",
    "project_channel_or_meeting",
    "project_or_context",
    "slack_connect_link",
    "timeline",
  ],
  body: `Hi {first_name},

Great to have you collaborating with us on {project_or_context}. Since this is a focused
single-project collaboration, we will keep logistics light: you will be added to
{project_channel_or_meeting} only, and {contact_name} is your contact for everything
project-related.

Your Slack invite comes through Slack Connect: {slack_connect_link}. Not already on Slack?
Join our free Jinesis space first, or the invite cannot go through:
https://join.slack.com/t/jinesis/shared_invite/zt-3d5p5t0nl-dsxvIZW3DJuC0b5lMkk3Vg

The expected scope is {deliverable}, on a rough timeline of {timeline}. If your availability
changes, just tell us early and we will adjust.

Best,
AdminBot`,
}
```

## PeopleFlow

### Slack Connect invitation for external profs: #friends-and-collaborators + project channel

Sender: AdminBot · Trigger: external-prof onboarding (after Zhijing/Andrew enters them in the
backend: email, project, optional collaborator list).

> **Subject: Slack invitation from the Jinesis Lab: [PROJECT_NAME]**
>
> Dear [NAME],
>
> To make day-to-day coordination on [PROJECT_NAME] easier, we would like to connect on Slack. You
> should shortly receive a Slack Connect invitation to the Jinesis workspace, which will add you to
> two channels:
>
> - {if proj id or alias provided}{#[proj-xxx]: the working channel for our project, where
>   [COLLABORATOR_NAMES] and Zhijing coordinate;}
> - #friends-and-collaborators: our lab's channel for the wider circle of collaborators (low traffic;
>   occasional announcements and papers).
>
> Being connected also means Jinesis members can reach you by direct message (and you them), which
> tends to make collaboration much easier than email threads.
>
> Slack Connect works from your own existing workspace, so there is no new account to manage. We
> would recommend that you use your most frequently used slack workspace (e.g., your main university
> or org affiliation) for convenience. If the invitation doesn't appear, check with your workspace
> admin or simply reply here and we will re-send it to a different email.
>
> Best regards,
> AdminBot, on behalf of the Jinesis AI Research Lab

### Interview invite

Trigger: backend, Zhijing will input — `role="interviewee"`, `email=…`, `task="interview_invite"`,
optional `backend_entry_of_google_form=…`.

> **Subject: Skill Set Alignment and Research Interest Exploration**
>
> Hello [Name],
>
> Thank you for your interest in working with Jinesis AI Research Lab.
>
> During the interview, please be prepared to share your screen and discuss some of your previous
> coding projects. We would also like to learn more about your academic background, technical
> experience, and the research areas you are interested in exploring.
>
> You should receive a Google Calendar invitation for the interview shortly. The event is editable,
> so please feel free to adjust the timing to a slot that works best for you. We may also make
> further adjustments to the schedule until we find a mutually convenient time, which will then be
> confirmed as the interview time. If you don't see the calendar invite be sure to check your spam
> folder.
>
> If you have any questions email akim@cs.toronto.edu. We look forward to speaking with you.
>
> Best regards,
> Jinesis AI Research Lab

### Interview result 1: Trial phase begins

> **Subject: Next Steps: Trial Phase with Jinesis AI Research Lab**
>
> Hi [NAME],
>
> Thank you for taking the time to interview with Jinesis AI Research Lab. We enjoyed learning more
> about your background, previous projects, and research interests.
>
> We are excited to invite you to the trial phase of the lab. During this period, you will work on a
> research or engineering task over the next three weeks. This will give both you and the team an
> opportunity to explore how your skills, working style, and research interests align with the lab.
>
> You will receive further details about the task and expectations from your interview lead. You will
> also be given access to Slack so you can communicate with the team and ask questions throughout the
> trial period.
>
> This will be your google drive workspace, [LINK]. This will be where you will be placing your CV,
> transcript, and your progress update for the project you are working on.
>
> We look forward to seeing your work and learning more about your contributions.
>
> Best regards,
> Jinesis AI Research Lab

### Interview result 2: forwarded to XX

Prof → allowing further routing to their students; PhD or postdoc friends like Florent.

⬜ **TODO** — students need to have agreed for their profile to be forwarded if applicable in form.
Cc: of applicant is applicable mostly when forwarding to PhD or postdoc friends who might be able to
reroute. Otherwise: Version b — private message to professors (e.g., Oana, Rada, Elliot), and the
applicant is not cc'd.

### Interview result 3: Rejection

> **Subject: Interview Result – Jinesis AI Research Lab**
>
> Dear [NAME],
>
> Thank you for taking the time to interview with Jinesis AI Research Lab and for sharing your
> experiences, projects, and research interests with us.
>
> After careful consideration, we have decided not to move forward with your application at this
> time. While we appreciate your interest in joining the lab and the effort you put into the
> interview process, we were unable to identify a suitable match between your current skills and
> experience and our current research needs.
>
> [⬜ TODO for us: recommended resources for student]
>
> We sincerely appreciate your interest in Jinesis AI Research Lab and wish you the best in your
> future academic and professional endeavors.
>
> Kind regards,
> Zhijing

### Accept Full Member

> **Subject: Welcome to the Jinesis Lab – Onboarding Steps**
>
> Hi${" ${name}" if first_name != None else ""},
>
> Thank you for your interest in joining the Jinesis Lab with Prof. Zhijing Jin! We're excited to
> have you on board. Our lab has recently developed an online lab management portal. Please follow
> the steps below:
>
> If you already have an @cs.toronto.edu email, please use it to create your member portal account at
> https://jinesis-admin.vercel.app/signup, and follow the onboarding guide in the portal.
>
> If you do not have an @cs.toronto.edu email, please click this link to receive an email, where you
> will be asked about your preferred email username. If possible, feel free to prioritize creating
> your email username like "firstname@cs.toronto.edu" or "lastname@cs.toronto.edu". If these names
> are taken, you can try {first_letter_of_first_name}{full_last_name}@cs.toronto.edu, e.g.,
> "zjin@cs.toronto.edu". If all the above choices have been taken, feel free to customize a username
> that relatively well reflects your first and last name, so we can use it for professional
> communications with senior external collaborators.
>
> After your @cs.toronto.edu email creation, feel free to use it to create your member portal account
> at https://jinesis-admin.vercel.app/signup, and follow the onboarding guide in the portal.
>
> If you are stuck on any of the above steps for over 2 business days, report the technical error to
> our lab admin Andrew Kim akim@cs.toronto.edu.
>
> Best regards,
> Jinesis Lab

### Full Member what to expect

For direct mentees of Zhijing:

- It means that I am directly responsible for your research and need to take care of your career
  path, mental health, etc.
- By default, you should send me at least one message a week in DM. For those that I am closely in
  loop with your project design, you're expected to send me a message every 10 hours of work, which
  might mean one message every day for some full-time researchers.
- Make sure that we are in contact on WhatsApp. If not, just send me a message at +86 1391 6675 066.
- A kind reminder for Zhijing's mentorship workflow: I will follow up to scroll through every recent
  document in our 1:1 folder. And then if I have limited theory of mind of your current situation
  (research wise, and also personally), I will directly reach out to call you on WhatsApp.
- If the call time doesn't work, just decline the call and suggest an alternative time. My schedule
  is still relatively fluid, so I will do a first round of calls whenever I'm taking a break from
  work (and also taking into consideration the time zone shown on your Slack profile).

### Accept as Guest

This directly invites the email through Slack Connect.

### External Senior Collaborator: Collaboration Kickoff

Professors, industry researchers, org leaders; peer or senior to Zhijing.

> Dear \_\_\_\_\_\_,
>
> We are very glad to be starting this collaboration on \_\_\_\_\_\_, and thank you for the materials
> and context you have shared so far.
>
> To make the collaboration smooth, a brief note on how our lab works. Research setup on our side
> takes some time: we prefer to come back with something well considered. So that quiet periods are
> never misread, we work on a simple rhythm: we will send you a substantive update roughly every
> \_\_\_\_\_\_ [default: 2 to 4 weeks], and between updates you can safely assume the project is
> moving. You are of course welcome to write to us at any point!
>
> Your main contact for day-to-day matters is \_\_\_\_\_\_ (cc'd), and Zhijing remains involved
> throughout. As immediate next steps, we suggest: \_\_\_\_\_\_.
>
> We are looking forward to this!
>
> Best regards,
> \_\_\_\_\_\_, on behalf of the Jinesis AI Lab

### External Junior Collaborator: Onboarding + Expectations

> Hi \_\_\_\_\_\_,
>
> Welcome aboard, we are excited to work with you on \_\_\_\_\_\_!
>
> How we work: the project meets \_\_\_\_\_\_ [cadence + channel], and your main point of contact is
> \_\_\_\_\_\_. We coordinate on Slack rather than email wherever possible; you will receive an
> invitation to the relevant channel(s) shortly. Progress updates are shared in the project channel,
> so a short weekly note on what you did, what is next, and any blockers is the norm even in slow
> weeks.
>
> Two things we ask of everyone: flag blockers early (a blocked week is normal, a silent blocked
> month is not), and let us know in advance about exams, internships, or travel so we can plan around
> them.
>
> Next steps: \_\_\_\_\_\_.
>
> Best,
> AdminBot

### Single-Project Collaborator (Nikita-type: one project, minimal access)

> Hi \_\_\_\_\_\_,
>
> Great to have you collaborating with us on \_\_\_\_\_\_. Since this is a focused single-project
> collaboration, we will keep logistics light: you will be added to \_\_\_\_\_\_ [project channel /
> meeting] only, and \_\_\_\_\_\_ is your contact for everything project-related.
>
> The expected scope is \_\_\_\_\_\_ [deliverable / role], on a rough timeline of \_\_\_\_\_\_. If
> your availability changes, just tell us early and we will adjust.
>
> Best,
> AdminBot

### High-Commitment External Collaborator (Michael Regan-type: 30-40 h/week)

> Hi \_\_\_\_\_\_,
>
> We are delighted you will be working with us at this level of involvement on \_\_\_\_\_\_. Given
> the time commitment, you will be onboarded close to a full member: Slack workspace, the
> \_\_\_\_\_\_ meetings, and the shared project folders.
>
> What we ask in return matches the commitment: attendance at \_\_\_\_\_\_ [core meetings], progress
> visible in the project channel week by week, and an early heads-up when your availability shifts.
> Your mentor/contact is \_\_\_\_\_\_, and the usual 3-month reflection point with Zhijing applies to
> you too.
>
> Next steps: \_\_\_\_\_\_.
>
> Best,
> AdminBot

### Collaboration Rhythm Reminder

Mid-project, when a counterpart misreads silence or floods the channel; the Jürgen case.

> Dear \_\_\_\_\_\_,
>
> A quick note on rhythm, since email can make quiet periods look like disinterest when the opposite
> is true. On our side, work on \_\_\_\_\_\_ is ongoing; our next substantive update will reach you
> by \_\_\_\_\_\_. Between updates, please read silence as work in progress. Naturally, if anything
> urgent comes up on your side, write any time and we will respond.
>
> Best regards,

### Zhijing's name policy / collaboration

_(Section header carried over from the source doc; no body text.)_

---

# Archived tasks

- ✅ Automatically add links to Zoom recordings for weekly / group meetings
- ⬜ Look into papers accepted at a conference and highlight ones that are relevant to my interests
- 💬 CV updates go directly to Google doc, no need for interface
- ✅ Calendar → and/or for location and timezone (portal IP city in last 3 days → slack timezone →
  then location if timezone not provided → slack group location) check prior; if not present, check
  next
- ✅ Time availability → allow edit events as well as remove
- 🟡 Logistics requests doc signature → Google form link (add deadline as a question)
- 💬 Batch 3 email improvements
