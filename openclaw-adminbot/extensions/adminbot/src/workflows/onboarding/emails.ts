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
    subject: `Skill Set Alignment and Research Interest Exploration`,
    required: ["first_name"],
    body: `Hello {first_name},

Thank you for your interest in working with Jinesis AI Research Lab.

During the interview, please be prepared to share your screen and discuss some of your previous coding projects. We would also like to learn more about your academic background, technical experience, and the research areas you are interested in exploring.

You should receive a Google Calendar invitation for the interview shortly. The event is editable, so please feel free to adjust the timing to a slot that works best for you. We may also make further adjustments to the schedule until we find a mutually convenient time, which will then be confirmed as the interview time. If you don't see the calendar invite be sure to check your spam folder.

If you have any questions email {contact_emails}. We look forward to speaking with you.

Best regards,
Jinesis AI Research Lab`,
  },
  {
    id: "rejection",
    kind: "candidate",
    subject: `Interview Result – Jinesis AI Research Lab`,
    required: ["first_name"],
    body: `Dear {first_name},

Thank you for taking the time to interview with Jinesis AI Research Lab and for sharing your experiences, projects, and research interests with us.

After careful consideration, we have decided not to move forward with your application at this time. While we appreciate your interest in joining the lab and the effort you put into the interview process, we were unable to identify a suitable match between your current skills and experience and our current research needs.

We sincerely appreciate your interest in Jinesis AI Research Lab and wish you the best in your future academic and professional endeavors.

Kind regards,
Zhijing`,
  },
  {
    id: "trial_phase",
    kind: "candidate",
    subject: `Next Steps: Trial Phase with Jinesis AI Research Lab`,
    required: ["drive_folder_link", "first_name", "slack_connect_link"],
    body: `Hi {first_name},

Thank you for taking the time to interview with Jinesis AI Research Lab. We enjoyed learning more about your background, previous projects, and research interests.

We are excited to invite you to the trial phase of the lab. During this period, you will work on a research or engineering task over the next three weeks. This will give both you and the team an opportunity to explore how your skills, working style, and research interests align with the lab.

You will receive further details about the task and expectations from your interview lead. You will also be given access to Slack so you can communicate with the team and ask questions throughout the trial period: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}

This will be your google drive workspace, {drive_folder_link}. This will be where you will be placing your CV, transcript, and your progress update for the project you are working on.

We look forward to seeing your work and learning more about your contributions.

Best regards,
Jinesis AI Research Lab`,
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
    required: ["dashboard_url", "first_name", "sender_name", "slack_connect_link"],
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
    subject: `Welcome aboard – your setup for {project_or_context}`,
    required: [
      "contact_name",
      "core_meetings",
      "first_name",
      "meeting_names",
      "next_steps",
      "project_or_context",
      "slack_connect_link",
    ],
    body: `Hi {first_name},

We are delighted you will be working with us at this level of involvement on {project_or_context}. Given the time commitment, you will be onboarded close to a full member: Slack workspace, the {meeting_names} meetings, and the shared project folders. Your Slack invite comes through Slack Connect: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}

What we ask in return matches the commitment: attendance at {core_meetings}, progress visible in the project channel week by week, and an early heads-up when your availability shifts. Your mentor/contact is {contact_name}, and the usual 3-month reflection point with Zhijing applies to you too.

Next steps: {next_steps}.

Best,
AdminBot`,
  },
  {
    id: "coauthor_minor",
    kind: "subgroup",
    subject: `Getting started on {project_or_context}`,
    required: [
      "contact_name",
      "discussion_channel",
      "drive_folder_link",
      "first_name",
      "meeting_cadence",
      "next_steps",
      "project_or_context",
      "slack_connect_link",
    ],
    body: `Hi {first_name},

Welcome aboard, we are excited to work with you on {project_or_context}!

How we work: the project meets {meeting_cadence}, and your main point of contact is {contact_name}. We coordinate on Slack rather than email wherever possible; you will receive an invitation to the relevant channel(s) shortly. Progress updates are shared in the project channel, so a short weekly note on what you did, what is next, and any blockers is the norm even in slow weeks.

Two things we ask of everyone: flag blockers early (a blocked week is normal, a silent blocked month is not), and let us know in advance about exams, internships, or travel so we can plan around them.

Where things live on Slack: #jinesis-with-friends-and-collaborators for our wider circle, #jinesis-active and #random-active for the lab's day-to-day, and {discussion_channel} for the broader topic your work sits in. Your invite: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}

Your project Google Drive folder is {drive_folder_link}. A few conventions save a lot of friction later: one long doc per topic rather than several tabs, kept Pageless, filenames prefixed with the date (yyyymmdd), and a flat folder so sorting by last-modified stays useful. I will send our Google file practices and what to expect working with us as a separate short note.

If you would like to follow the lab more widely, there is our newsletter, https://www.linkedin.com/company/jinesis-lab/ and {lab_x_url}.

You are also welcome at our city dinners and team building events.

Next steps: {next_steps}.

Best,
AdminBot`,
  },
  {
    id: "disappearing_coauthor",
    kind: "subgroup",
    subject: `Staying in touch on {project_or_context}`,
    required: ["first_name", "project_or_context", "sender_name", "slack_connect_link"],
    body: `Hi {first_name},

Thanks for the work you have put into {project_or_context}. Since you are fitting this around a lot of other things, we want to keep it light and predictable:

- Slack Connect to #jinesis-with-friends-and-collaborators, so you are reachable without email round-trips: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}
- We will email you to confirm your time plan rather than assume it, so you always know what is expected and when. If a stretch is not going to work, just say so on the reply.
- Papers have a habit of coming back months later for a resubmission. So we can still reach you then, it helps to have an address that does not expire with an institution — reply with one if your current address might.

Best,
{sender_name}`,
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
    subject: `Welcome to the Jinesis AI Research Lab – Onboarding Steps`,
    // `first_name` is deliberately absent: it is an optional value token, so an unnamed recipient
    // gets "Hi," rather than a refusal. See OPTIONAL_VALUE_TOKENS in guide.ts.
    required: [],
    body: `Hi {first_name},

Thank you for your interest in joining the Jinesis AI Research Lab with Prof. Zhijing Jin! We're excited to have you on board.

To complete your onboarding, please complete the following:

- You will soon receive an email asking you to create a @cs.toronto.edu email
  - Highly Preferred format:
    - Top 1 choice: yourFirstName@cs.toronto.edu, or yourLastName@cs.toronto.edu, e.g., david@cs.toronto.edu or smith@cs.toronto.edu
    - Top 2 choice: {first_letter_of_first_name}{full_last_name}@cs.toronto.edu, e.g., {email_format_example}
    - Otherwise you can pick one that you like. Our high preference is to make it very much reflect your first and last name, so we can use it for professional communications with senior external collaborators.
- Once that is created, use that email to create your member portal account: Sign up at https://jinesis-admin.vercel.app/signup and follow the onboarding guide in the portal.

If any of the steps does not proceed within 7 business days after you have done it, report the technical error to {contact_emails}.

Best regards,
Jinesis AI Research Lab`,
  },
] as const satisfies readonly AdminBotOnboardingTemplate[];

export type AdminBotOnboardingTemplateId = (typeof ADMINBOT_ONBOARDING_TEMPLATES)[number]["id"];

export function findOnboardingTemplate(id: string): AdminBotOnboardingTemplate | undefined {
  return ADMINBOT_ONBOARDING_TEMPLATES.find((entry) => entry.id === id);
}
