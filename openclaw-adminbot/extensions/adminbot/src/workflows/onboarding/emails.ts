// Onboarding guide emails, one per membership tier. This module is the source of the copy:
// the templates were reviewed as markdown and folded in here so a string lives in exactly one
// place and ships with the service instead of being read off disk at runtime.
//
// Three rules the send path enforces, recorded next to the copy they constrain:
//   1. Never send with an unfilled placeholder. `required` is the contract; a literal
//      "{contact_name}" reaching a collaborator is worse than not sending.
//   2. Subjects never name the tier. The recipient has no idea which internal bucket they are in
//      and must not learn it from a subject line.
//   3. Bodies carry no hard wrapping. A wrap inside a paragraph becomes a literal newline in the
//      delivered mail; breaks exist only between blocks. The ~70-character breaks the operator
//      used to see came from delivering text/plain, not from these strings: the send path now
//      renders an HTML alternative from the same body (connectors/email-html.ts).
//   4. Bullets are "- " at column 0, nested one level per two spaces. That indentation is the only
//      list syntax the HTML renderer understands, so a bullet written any other way ships as a
//      paragraph.
//
// Some placeholders are not filled by the operator but by deployment configuration -- the Slack
// invite link, the bot's own address, the contact addresses, the social links. They are listed in
// `guide.ts` (`REQUIRED_DEPLOYMENT_TOKENS` / `OPTIONAL_DEPLOYMENT_TOKENS`) rather than in a
// template's `required`, because they are the same for every recipient and must never be typed in
// by hand. A template using an optional one keeps it alone on its own line: an unset optional token
// drops the whole line rather than shipping a half-rendered sentence.

/** How the tab picks a template. */
export type AdminBotOnboardingTemplateKind = "privilege" | "subgroup" | "candidate" | "supplement";

export type AdminBotOnboardingTemplate = {
  id: string;
  kind: AdminBotOnboardingTemplateKind;
  /** Absent only for the supplement that is appended to another email rather than sent alone. */
  subject?: string;
  body: string;
  /** Every placeholder the body or subject needs before this may be sent. */
  required: readonly string[];
};

export const ADMINBOT_ONBOARDING_TEMPLATES = [
  {
    id: "interview_invite",
    kind: "candidate",
    subject: `Interview with the Jinesis Lab`,
    required: ["first_name"],
    body: `Hello {first_name},

Thank you for your interest in working with the Jinesis Lab!

During the interview, please be prepared to share your screen and walk us through some of your previous coding projects. We would also like to learn more about your academic background, technical experience, and the research areas you are interested in exploring.

You will receive a Google Calendar invitation for the interview shortly. The event is editable, so feel free to move it to a slot that works better for you; we may adjust it further until we find a mutually convenient time, which then counts as confirmed. If you don't see the invitation, please check your spam folder.

If you have any questions, email {contact_emails}. We look forward to speaking with you!

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "rejection",
    kind: "candidate",
    subject: `Interview Result: Jinesis Lab`,
    required: ["first_name"],
    body: `Dear {first_name},

Thank you for taking the time to interview with the Jinesis Lab and for sharing your experience, projects, and research interests with us.

After careful consideration, we have decided not to move forward with your application at this time. We were unable to identify a strong match between your current experience and the lab's present research needs.

If helpful, you may also find this public collection of resources on research skills, mentorship programs, applications, and academic career development useful: NLP PhD Global Equality.

We sincerely appreciate your interest in the lab and wish you the best in your academic and professional path.

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "trial_phase",
    kind: "candidate",
    subject: `Next Steps: Trial Phase with the Jinesis Lab`,
    required: ["drive_folder_link", "first_name"],
    body: `Hi {first_name},

Thank you for taking the time to try out research projects with the Jinesis Lab. As per our lab tradition, before fully committing to a project collaboration, we try matching researchers with various projects to find the perfect way to make use of your talents and maximize our synergy.

We are excited to invite you to the trial phase. Over the next three weeks, you will work on a research or engineering task; this gives both you and the team a chance to see how your skills, working style, and interests align with the lab. You will receive the task details and expectations from your interview lead.

Two things are set up for you already:

1. Google Drive workspace: {drive_folder_link}. Please place your CV, transcript, and progress updates for your task here.

2. Slack: You will have access to a guest chat with Zhijing and your interview lead, so you can ask questions throughout the trial.

We look forward to seeing your work!

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "collaboration_rhythm_reminder",
    kind: "supplement",
    subject: `Where we are on {project_or_context}`,
    required: ["first_name", "project_or_context", "update_due_date"],
    body: `Dear {first_name},

A quick note on rhythm, since email can make quiet periods look like disinterest when the opposite is true. On our side, work on {project_or_context} is ongoing; our next substantive update will reach you by {update_due_date}. Between updates, please read silence as work in progress. Naturally, if anything urgent comes up on your side, write any time and we will respond.

Best regards,`,
  },
  {
    id: "acquaintance",
    kind: "subgroup",
    subject: `Joining our collaborators channel`,
    required: [
      "drive_folder_link",
      "first_name",
      "project_or_context",
      "sender_name",
      "slack_connect_link",
    ],
    body: `Hi {first_name},

Good to be working alongside you on {project_or_context}. A few things to connect you properly:

- Slack Connect to #jinesis-with-friends-and-collaborators, where our wider circle keeps in touch: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}
- Our project Google Drive folder: {drive_folder_link}
- If you want to follow what we publish: Zhijing on LinkedIn ({pi_linkedin_url}), the lab at https://www.linkedin.com/company/jinesis-lab/, and {lab_x_url}

We also run city-based dinners and team building events, and would be glad to have you at the next one near you.

Best,
{sender_name}`,
  },
  {
    id: "alumni",
    kind: "subgroup",
    subject: `Keeping in touch`,
    // `dashboard_url` is deployment configuration, not a value the sender types; see guide.ts.
    required: ["first_name", "sender_name", "slack_connect_link"],
    body: `Hi {first_name},

You may have moved on from the day-to-day, but you are still part of this lab, and we would like to keep it that way.

- #general-channel-with-external-collaborators-and-alumni on Slack Connect, where people who have worked with us stay in touch: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}
- Your dashboard account stays active at {dashboard_url} — the roster, active papers and their deadlines, and the reimbursement tool are all still there.
- Our newsletter, plus https://www.linkedin.com/company/jinesis-lab/ and {lab_x_url}, if you want to see what comes out next.

Two practical things. If you ever need a recommendation letter, just ask — we know your work and are glad to write one. And it is worth making sure we have a personal email for you that survives your institutional one, so we can still reach you about a resubmission years from now; reply with one if that has changed.

You are on the list for city dinners and team building events too. Hope to see you at one.

Best,
{sender_name}`,
  },
  {
    id: "coauthor_major",
    kind: "subgroup",
    subject: `Welcome to the Jinesis Lab: your onboarding steps`,
    required: [
      "discussion_channel",
      "drive_folder_link",
      "drive_guide_link",
      "first_name",
      "meeting_channel",
      "project_channel",
    ],
    body: `Hi {first_name},

A very warm welcome to the Jinesis Lab! Below are the introductions to our lab management system:

1. Member portal: Create your account at https://jinesis-admin.vercel.app/signup and fill out "My Profile" completely, including your preferred professional email; this is what we use for paper submissions and external communications.

2. Slack: You will be invited to #jinesis-active, #random-active, your project channel {project_channel}, and the {discussion_channel} channel(s) for your area. Day-to-day coordination happens here, not by email.

3. Meetings: you will be added to {meeting_channel} and receive calendar invites for the weekly meeting and the Wednesday-themed meeting. One important habit: rely on the Google Calendar app with alerts, and ignore calendar-related emails. Our meetings span time zones, and the app is the only reliable source of truth.

4. Google Drive: your project folder is here: {drive_folder_link}. Please also read the short "Google file common practice" guide {drive_guide_link}; it keeps everyone's files findable.

5. Newsletter and socials: You are also very welcome to subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com, and to follow the lab on LinkedIn and Twitter/X.

If an invitation has not arrived within a week, or if anything is unclear, please reply here, and we will be happy to help.

Best regards,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    // Not a clone of the coauthor_major setup mail: a 5-10 h/week collaborator is onboarded to the
    // project rather than to the lab, so there is no portal account and no #jinesis-active, and the
    // mail names who to ask when Zhijing is busy.
    id: "coauthor_minor",
    kind: "subgroup",
    subject: `Welcome to the Jinesis Lab: your onboarding steps`,
    required: [
      "discussion_channel",
      "drive_folder_link",
      "drive_guide_link",
      "first_name",
      "meeting_channel",
      "primary_contact",
      "project_channel",
    ],
    body: `Hi {first_name},

A very warm welcome to the Jinesis Lab! To facilitate our project collaboration, we recommend the following onboarding setup at the lab:

1. Slack: You will be invited to #random-active, your project channel {project_channel}, and the {discussion_channel} channel(s) for your area. Day-to-day coordination happens here, not by email.

2. Meetings: you will be added to {meeting_channel} and receive calendar invites for the weekly meeting and the Wednesday project-themed meeting. One important habit: rely on the Google Calendar app with alerts, and ignore calendar-related emails. Our meetings span time zones, and the app is the only reliable source of truth.

3. Google Drive: your project folder is here: {drive_folder_link}. Please also read the short "Google file common practice" guide {drive_guide_link}; it keeps everyone's files findable.

4. Newsletter and socials: You are also very welcome to subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com, and to follow the lab on LinkedIn and Twitter/X.

5. Day-to-Day Contact: Whenever Zhijing is busy, your primary source of contact will be {primary_contact}.

If an invitation has not arrived within a week, or if anything is unclear, please reply here, and we will be happy to help.

Best regards,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "disappearing_coauthor",
    kind: "subgroup",
    subject: `Checking in about your Jinesis involvement`,
    required: ["first_name", "project_or_context"],
    body: `Hi {first_name},

We hope things are going well on your side. We have not heard from you for a while regarding {project_or_context} and wanted to check what level of involvement currently works for you.

One option is to move you to alumni status. This has no ongoing obligations: you remain on the newsletter and in #friends-and-collaborators, receive invites to dinners in your city, and stay connected to anything you have co-authored.

If you later have the capacity and interest to return as a half-time or full-time collaborator, you are very welcome to do so. Because you have already worked with us, starting new projects together would be straightforward.

Would you be comfortable moving to alumni status for now? A short reply is enough, and you are also very welcome to tell us if another arrangement would work better.

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "interviewee",
    kind: "subgroup",
    subject: `Following up after our conversation`,
    required: [
      "drive_folder_link",
      "first_name",
      "project_or_context",
      "sender_name",
      "slack_connect_link",
    ],
    body: `Hi {first_name},

Thanks for taking the time to talk with us about {project_or_context}. So the conversation can keep going, we have set a few things up for you:

- A Slack guest chat with Zhijing and the team, so you can ask things as they come up rather than saving them for email: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}
- Our project Google Drive folder: {drive_folder_link}
- If you would like to follow along more generally: Zhijing on LinkedIn ({pi_linkedin_url}), the lab at https://www.linkedin.com/company/jinesis-lab/, and {lab_x_url}

We also run city-based dinners and team building events, and you are welcome at them — we will send an invite when the next one is near you.

I will send a short separate note shortly on how we work with shared files, which is worth two minutes before you open the Drive folder.

Best,
{sender_name}`,
  },
  {
    id: "external_prof",
    kind: "subgroup",
    subject: `Starting our collaboration on {project_or_context}`,
    required: [
      "contact_name",
      "first_name",
      "next_steps",
      "project_or_context",
      "sender_name",
      "slack_connect_link",
      "update_cadence",
    ],
    body: `Dear {first_name},

We are very glad to be starting this collaboration on {project_or_context}, and thank you for the materials and context you have shared so far.

To make the collaboration smooth, a brief note on how our lab works. Research setup on our side takes some time: we prefer to come back with something well considered. So that quiet periods are never misread, we work on a simple rhythm: we will send you a substantive update roughly every {update_cadence}, and between updates you can safely assume the project is moving. You are of course welcome to write to us at any point!

Your main contact for day-to-day matters is {contact_name} (cc'd), and Zhijing remains involved throughout. As immediate next steps, we suggest: {next_steps}.

Two practical things. You are invited to our Slack workspace through Slack Connect, in #jinesis-with-friends-and-collaborators, which is low traffic and a good way to reach us without a formal email: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}

We will also email you at the points that matter on the projects you are attached to: when a paper is submitted or resubmitted, and when a social media draft goes out for review, so nothing goes public with your name on it without you having seen it. If you would rather we narrowed or widened that, just say.

We are looking forward to this!

Best regards,
{sender_name}, on behalf of the Jinesis AI Lab`,
  },
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

Great to have you collaborating with us on {project_or_context}. Since this is a focused single-project collaboration, we will keep logistics light: you will be added to {project_channel_or_meeting} only, and {contact_name} is your contact for everything project-related.

Your Slack invite comes through Slack Connect: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}

The expected scope is {deliverable}, on a rough timeline of {timeline}. If your availability changes, just tell us early and we will adjust.

Best,
AdminBot`,
  },
  {
    id: "member_rejection",
    kind: "privilege",
    subject: `Update on your Jinesis AI Research Lab application`,
    required: ["first_name"],
    body: `Dear {first_name},

Thank you for your interest in joining the Jinesis Lab and for taking the time to share your experience with us.

After careful consideration, we were unable to identify a suitable match between your current skill set and the lab's present needs. As a result, we will not be moving forward with your application at this time.

We sincerely appreciate your interest and wish you the very best in your future opportunities and search.

Kind regards,
Zhijing`,
  },
  {
    id: "member_what_to_expect",
    kind: "supplement",
    subject: `Working with Zhijing – what to expect`,
    required: ["zhijing_whatsapp"],
    body: `For direct mentees of Zhijing:

It means that I am directly responsible for your research and need to take care of your career path, mental health, etc.

By default, you should send me at least one message a week in DM. For those that I am closely in loop with your project design, you're expected to send me a message every 10 hours of work, which might mean one message every day for some full-time researchers.

Make sure that we are in contact on WhatsApp. If not, just send me a message at {zhijing_whatsapp}

A kind reminder for Zhijing's mentorship workflow: I will follow up to scroll through every recent document in our 1:1 folder. And then if I have limited theory of mind of your current situation (research wise, and also personally), I will directly reach out to call you on WhatsApp.

If the call time doesn't work, just decline the call and the suggestion and an alternative time. My schedule is still relatively fluid, so I will a first round of calls whenever I'm taking a break from work (and also taking into consideration the time zone shown on your Slack profile).`,
  },
  {
    id: "member",
    kind: "privilege",
    subject: `Welcome to the Jinesis Lab – Onboarding Steps`,
    // `first_name` is deliberately absent: it is an optional value token, so an unnamed recipient
    // gets "Hi," rather than a refusal. See OPTIONAL_VALUE_TOKENS in guide.ts.
    required: [],
    // Interim wording: accounts were bulk-created for the roster with one shared temporary
    // password, so this tells people to sign in and change it rather than to sign up. It goes back
    // to pointing at /signup once that backfill is no longer how members get an account.
    body: `Hi {first_name},

Thank you for your interest in joining the Jinesis Lab with Prof. Zhijing Jin! We're excited to have you on board. Our lab has recently developed an online lab management portal. Please follow the steps below:

If you already have an @cs.toronto.edu email, an account has already been created for you. Sign in at https://jinesis-admin.vercel.app with that email address and the temporary password "jinesis", then change it from Change password in the sidebar. Once you are in, follow the onboarding guide in the portal.

If you do not have an @cs.toronto.edu email yet, you will receive an email asking about your preferred email username. If possible, feel free to prioritize a username like "firstname@cs.toronto.edu" or "lastname@cs.toronto.edu". If those are taken, you can try {first_letter_of_first_name}{full_last_name}@cs.toronto.edu, e.g., "{email_format_example}". If all of the above are taken, feel free to customize a username that reflects your first and last name reasonably well, so we can use it for professional communications with senior external collaborators.

Once your @cs.toronto.edu email is created, tell us and we will set up your portal account the same way.

If you are stuck on any of the above steps for over 2 business days, report the technical error to our lab admin Andrew Kim at akim@cs.toronto.edu.

Best regards,
Jinesis Lab`,
  },

  {
    id: "own_pace_advisee",
    kind: "subgroup",
    subject: `Welcome to Jinesis: a few onboarding steps`,
    required: ["first_name", "meeting_arrangement"],
    body: `Hi {first_name},

A very warm welcome to the Jinesis Lab with Prof. Zhijing Jin! We are very happy to have you with us.

To make getting settled as easy as possible, here are a few first steps:

1. Member portal: Please create your account at https://jinesis-admin.vercel.app/signup and complete "My Profile." Please include a personal email address that you expect to retain if your institutional affiliation changes.

2. Slack: You will receive invitations to the workspace and the channels relevant to you, including your research discussion and project channels. Most of our everyday communication happens there.

3. Google Drive: A shared 1:1 folder with Zhijing will be created and shared with you. Please use it as the main home for materials related to your work together, including notes, drafts, and progress updates. It will also contain the internal guidebook and links to relevant shared resources.

4. Meetings: {meeting_arrangement} Zhijing will send you a separate note explaining how meetings and communication usually work in the lab.

5. Staying connected: You are also very welcome to subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com, and to follow the lab on LinkedIn and Twitter/X.

If an invitation has not arrived within a week, or if anything is unclear, please reply here, and we will be happy to help.

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "own_pace_advisee_norms",
    kind: "supplement",
    subject: `How we work at Jinesis: communication and meetings`,
    required: ["first_name"],
    body: `Hi {first_name},

We would like to share a few habits that help research collaborations run smoothly at Jinesis.

Keep us updated regularly on Slack. Short, substantive updates are usually most useful: what you learned, what remains uncertain, and what you plan to do next. There is no need to wait until you have enough material for a long technical report.

Please communicate changes in your availability early. If coursework, co-supervision, travel, or other commitments will affect your work, let us know the expected period and how you plan to adjust. This helps everyone coordinate and keeps the project moving.

Meetings are an important part of the collaboration. If the Monday lab meeting applies to you, regular attendance is expected. The Wednesday meeting or meetings related to your research area are highly recommended. These are also where we share much of the practical knowledge around venues, authorship, submissions, and research decisions.

For logistical questions, please first check the relevant sections of the guidebook available to you. If the answer is unclear or your situation is unusual, you are always welcome to ask in your project channel.

We are very happy to have you working with us and look forward to seeing the project develop!

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "coauthor_major_norms",
    kind: "supplement",
    subject: `Your project team at the Jinesis Lab`,
    required: ["contact_name", "first_name", "project_or_context", "team_lead_role"],
    body: `Hi {first_name},

We are delighted to have you on {project_or_context}. Here is how your project team will work with you.

Your project team. {contact_name} ({team_lead_role}) is your main contact for planning, implementation, and feedback. Zhijing stays closely involved in research direction, framing, major decisions, and final paper quality. Please use the project channel when possible so everyone can contribute.

Staying in sync. Please share a short update in the project channel roughly every 10 hours of work, covering findings, decisions, next steps, and blockers. Longer technical details can go in a shared document or meeting.

Meetings. The Monday lab meeting is mandatory, and the Wednesday themed meeting for your topic is highly recommended. They also cover shared practices around venues, submissions, authorship, and rebuttals.

Logistics. For venue choice, authorship, deadlines, and reimbursements, please check the relevant section of our guidebook first. If your situation is not covered, {contact_name} and the team will be happy to help.

We are excited to work with you and see the project develop.

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "coauthor_minor_norms",
    kind: "supplement",
    subject: `Your project team at the Jinesis Lab`,
    required: ["contact_name", "first_name", "project_or_context", "team_lead_role"],
    body: `Hi {first_name},

We are delighted to have you on {project_or_context}. Here is how your project team will work with you.

Your project team. {contact_name} ({team_lead_role}) is your main contact for planning, implementation, and feedback. Zhijing stays closely involved in research direction, framing, major decisions, and final paper quality. Please use the project channel when possible so everyone can contribute.

Staying in sync. Please share a short update in the project channel roughly every 10 hours of work, covering findings, decisions, next steps, and blockers. Longer technical details can go in a shared document or meeting.

Meetings. The Monday lab meeting is mandatory, and the Wednesday themed meeting for your topic is highly recommended. They also cover shared practices around venues, submissions, authorship, and rebuttals.

Logistics. For venue choice, authorship, deadlines, and reimbursements, please check the relevant section of our guidebook first. If your situation is not covered, {contact_name} and the team will be happy to help.

We are excited to work with you and see the project develop.

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "disappearing_coauthor_paper",
    kind: "supplement",
    subject: `Next steps for {paper_short_title}`,
    required: ["delegate_name", "first_name", "paper_short_title", "paper_title", "reply_by_date"],
    body: `Hi {first_name},

We hope things are going well on your side. We would like to agree on how to move "{paper_title}" forward. Please choose one of the following arrangements:

1. Jinesis takes over the project. {delegate_name} becomes responsible for the day-to-day work and next submission steps. We will ask you to provide any files, context, or access needed for the handover.

2. You remain involved at key decision points. Jinesis manages the day-to-day work, while you commit to reviewing materials and responding by the agreed deadlines when we contact you about the venue, major revisions, or final sign-off.

We would appreciate it if you could reply by {reply_by_date} with your preferred option and any context we should know. If we do not hear from you by then, we will proceed with option 1.

Thank you again for your work on the paper!

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    // An automatic decline: the access table makes this the standing answer for someone at
    // disappearing-coauthor status, so it is copy rather than a judgement call per request.
    id: "disappearing_coauthor_rec_letter",
    kind: "supplement",
    subject: `Re: your recommendation letter request`,
    required: ["first_name"],
    body: `Hi {first_name},

Thank you for reaching out, and for the work you have done with Jinesis.

Recommendation letters are available only in specific collaboration circumstances. Based on your current collaboration status, we are unable to support this request.

We appreciate your understanding and wish you all the best with your application.

Warmly,
AdminBot, on behalf of the Jinesis Lab`,
  },

  // The three external-professor logistics mails. They are onboarding touchpoints rather than
  // guides -- each one announces something that has just been provisioned -- so they are sent on
  // their own and carry AdminBot's voice rather than a project lead's. The rest of the
  // external-professor set (submission sign-off, decisions, social media, dinners) belongs to the
  // paper lifecycle, not to onboarding, and lives with PaperFlow.
  {
    id: "external_prof_slack_connect",
    kind: "supplement",
    subject: `Slack invitation from the Jinesis Lab`,
    required: ["collaborator_names", "first_name", "project_channel", "project_or_context"],
    body: `Dear {first_name},

To make day-to-day coordination on {project_or_context} easier, we would like to connect on Slack. You should shortly receive a Slack Connect invitation to the Jinesis workspace, which will add you to two channels:

- {project_channel}: the working channel for our project, where {collaborator_names} and Zhijing coordinate
- #friends-and-collaborators: our lab's channel for the wider circle of collaborators (low traffic; occasional announcements and papers)

Once connected, you and Jinesis members can also communicate by direct message. Slack Connect works from your existing workspace, so there is no new account to manage. We recommend using your primary university or organization workspace. If the invitation does not appear, check with your workspace admin or reply here and we will re-send it to a different email.

Best regards,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    id: "external_prof_drive_folder",
    kind: "supplement",
    subject: `Shared folder for {project_or_context}`,
    // `project_folder_link`, not `drive_folder_link`: that token makes the send path provision a
    // new 1:1 workspace folder, and this mail shares a project folder that already exists.
    required: ["first_name", "folder_contents", "project_folder_link", "project_or_context"],
    body: `Dear {first_name},

We have shared the project folder for {project_or_context} with this email address: {project_folder_link}

It contains {folder_contents}. Feel free to add or comment on anything. The folder is the single home for project files, so materials shared there stay findable for everyone.

If you would prefer access under a different Google account, reply with the address and we will update the sharing.

Best regards,
AdminBot, on behalf of the Jinesis Lab`,
  },

  {
    // Deliberately light: an external professor fills in nothing, they only confirm what we hold.
    // Sent at onboarding and re-verified about every six months.
    id: "external_prof_records_check",
    kind: "supplement",
    subject: `One-minute check: our contact record for you`,
    required: ["first_name", "record_email", "record_name", "record_projects", "record_role"],
    body: `Dear {first_name},

As part of our collaboration records, we currently have you as:

- Name: {record_name}
- Role: {record_role}
- Preferred email: {record_email}
- Collaborating with us on: {record_projects}

If this is accurate, no reply is needed. Otherwise, reply with any corrections, especially to your preferred email.

Best regards,
AdminBot, on behalf of the Jinesis Lab`,
  },
] as const satisfies readonly AdminBotOnboardingTemplate[];

export type AdminBotOnboardingTemplateId = (typeof ADMINBOT_ONBOARDING_TEMPLATES)[number]["id"];

export function findOnboardingTemplate(id: string): AdminBotOnboardingTemplate | undefined {
  return ADMINBOT_ONBOARDING_TEMPLATES.find((entry) => entry.id === id);
}
