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

// `acquaintance`, `coauthor_discussant_designer` and `external_prof` deliberately have no
// onboarding template. Those collaborations do not open with a welcome mail: the access-level
// algorithm (collaborator-subgroups.ts) grants the subgroup's access items in the backend, and
// that is the whole onboarding. Do not re-add one without Zhijing asking for it.
export const ADMINBOT_ONBOARDING_TEMPLATES = [
  {
    // The proofread "top1" variant: a 30-minute conversation with Zhijing. Two sibling variants
    // below cover the other two routes the lab offers an applicant.
    id: "interview_invite",
    kind: "candidate",
    subject: `Interview with the Jinesis Lab`,
    required: [],
    body: `Hi!

Thank you for your interest in working with the Jinesis Lab! We have reviewed your Google Form response and would like to proceed to the interview stage with the lab.

You will receive a Google Calendar invitation for the interview shortly. The event is editable, so feel free to move it to a slot that works better for you; we may adjust it further until we find a mutually convenient time. If you don't see the invitation, please check your spam folder.

During the interview, please be prepared to share your screen and walk us through some of your previous projects. We would also like to learn more about your career goals, academic background, technical experience, and the research areas you are interested in exploring.

If you have any questions, please email {contact_emails}. We look forward to speaking with you!

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // "top2": no interview slot, a themed meeting and the discussion channel instead. The Slack
    // join link is the free-workspace fallback for an applicant with no Slack of their own.
    id: "interview_invite_theme_meeting",
    kind: "candidate",
    subject: `Interview with the Jinesis Lab`,
    required: [],
    body: `Hi!

Thank you for your interest in working with the Jinesis Lab! We have reviewed your Google Form response and would like to have a trial period for us to match your interests and skill sets to appropriate projects in our lab.

Roughly, this will be a 3-4 week interaction with our existing project members and project meetings to see how seamlessly you integrate into our projects.

You will be invited to the relevant discussion Slack channel and receive a calendar invite to the discussion meeting on the relevant topic. If you have never used Slack before, please join our temporary workspace through the link below to be invited to our main UofT Slack: {slack_invite_url}

If you have any questions, feel free to ask Zhijing on Slack after the group meeting. We look forward to speaking with you!

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // "Matching-with-specific-projects": Zhijing will not supervise directly, so the applicant is
    // forwarded to a project lead who is cc'd on the thread and becomes their point of contact.
    id: "interview_invite_project_matching",
    kind: "candidate",
    subject: `Your application to the Jinesis Lab`,
    // `task_recommendation` is the whole personalised sentence, not a fragment: it names the lead
    // and the task, carries the task doc inline when the lead has one, and numbers the parts
    // "(1) ... and (2) ..." when two leads share the applicant. It is written per applicant by
    // AdminBotEmailModel.projectMatch(), which owns that wording.
    //
    // `application_form_link` must be the applicant's *own* response
    // (.../viewform?edit2=<token>), never the bare form and never the response sheet: the mail is
    // addressed to one applicant and cc's the lead, so a link to everyone's answers would put the
    // rest of the batch in front of both.
    required: ["application_form_link", "task_recommendation"],
    body: `Hi!

Thank you for your interest in working with the Jinesis Lab! Zhijing has personally reviewed your Google Form response. Although she will not directly personally work with you, we may have opportunities for you to work on some test tasks to help with other ongoing projects in the lab.

If you have the capacity to do a small research contribution (e.g., for about 4 weeks with us), we have forwarded your application form {application_form_link} and skill sets to our Jinesis project lead cc'ed. They will review and reach out if they welcome a helping hand. {task_recommendation}

If the lead finds it a fit, they will reply to this email thread. Your main point of contact will be the lead cc'ed, who will check your technical contributions after you share your code implementation and report with them. There might still be a chance that either they are at full capacity or the project is not a match.

Good luck!

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    id: "rejection",
    kind: "candidate",
    subject: `Interview Result: Jinesis Lab`,
    required: ["first_name"],
    body: `Dear {first_name},

Thank you for taking the time to interview with the Jinesis Lab and for sharing your experience, projects, and research interests with us.

After careful consideration, we have decided not to move forward at this time. We were unable to identify a strong match between your current experience and the lab's present research needs.

If helpful, you may also find this public collection of resources on research skills, mentorship programs, applications, and academic career development useful: NLP PhD Global Equality.

We sincerely appreciate your interest in the lab and wish you the best in your academic and professional path.

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    id: "trial_phase",
    kind: "candidate",
    subject: `Next Steps: Trial Phase with the Jinesis Lab`,
    required: ["drive_folder_link", "first_name"],
    body: `Hi {first_name},

Thank you for taking the time to try out research projects with the Jinesis Lab. As per our lab tradition, before fully committing to a project collaboration, we try matching researchers with various projects to find the perfect way to make use of your talents and maximize our synergy.

Over the next three weeks you'll work on a research or engineering task, which gives both you and the team a chance to see how your skills, working style, and interests line up.

Two things are set up for you already:

1. Google Drive workspace: {drive_folder_link}. Please place your CV, transcript, and progress updates for your task here.

2. Slack: You will have access to a guest chat with Zhijing, so you can ask questions throughout the trial.

We look forward to seeing your work!

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // Section G of the template doc: the first reply to somebody who wrote in cold, before any
    // application exists. It only points at the form.
    id: "outreach_reply",
    kind: "candidate",
    subject: `Thank You for Reaching Out`,
    required: ["application_form_link", "first_name"],
    body: `Hi {first_name},

Thanks so much for getting in touch! To help us review your information and make sure nothing gets missed, please fill out our application form here: {application_form_link}

We really appreciate your time and look forward to learning more about you.

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
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
    // The template doc's version says only that a Slack Connect invitation is on its way. The link
    // token is kept in the copy regardless: the send path provisions the invite only when the body
    // still mentions {slack_connect_link}, so removing it would promise an invitation that no
    // longer gets minted.
    id: "alumni",
    kind: "subgroup",
    subject: `Staying Connected with the Jinesis Lab`,
    required: ["first_name", "slack_connect_link"],
    body: `Hi {first_name},

This is Professor Zhijing Jin's research lab, now known as Jinesis Lab at the University of Toronto, Department of Computer Science.

You are receiving this email because you have worked with us in the past, and Zhijing would like to add you to our alumni network.

We welcome you to keep an active profile on our lab portal {dashboard_url}

1. If you have used the lab portal in the past, your account will remain valid. Otherwise, create an account using your personal email.

2. Feel free to keep updating your profile in the "My Profile" tab, especially the "CV", "your residence city", and LinkedIn fields, so we can connect and keep posted on your latest updates, and may organize gatherings in your local city and invite you by calendar.

3. Also, you can use the portal for the following features: request a recommendation letter from Zhijing; check conference deadline countdown at https://jinesis-admin.vercel.app/adminbot/deadlines (no login needed); and find interesting papers at https://jinesis-admin.vercel.app/adminbot/conference-papers (no login needed).

4. Slack: If you still use Slack, we will send a Slack Connect invitation to our Jinesis friends and alumni channel: {slack_connect_link}. Not already on Slack? Join our free Jinesis space first, or the invite cannot go through: {slack_invite_url}

5. Keep updated by following our social media accounts:

- LinkedIn: Zhijing-Jin, Jinesis-Lab, EuroSafeAI
- X / Twitter: ZhijingJin, JinesisLab, EuroSafeAI
- Subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com

You are welcome to join any of our gathering events too. Hope to see you at one!

Warmly,
Jinesis Lab by Prof. Zhijing Jin, University of Toronto`,
  },
  {
    // The portal credential is a per-send value rather than copy: the lab hands out a starting
    // password on this mail, and a shared literal in the tree would be a checked-in credential.
    // The Drive step is not in the template doc's version of this mail but is kept, because the
    // access matrix grants coauthor_major both the project folder and the file-practice guide
    // outright (google_file_practice_guide is a plain `yes` for this subgroup, not `yes_separate`),
    // and dropping {drive_folder_link} would also stop the send provisioning the folder at all.
    id: "coauthor_major",
    kind: "subgroup",
    subject: `Welcome to the Jinesis Lab: your onboarding steps`,
    required: [
      "drive_folder_link",
      "drive_guide_link",
      "first_name",
      "member_email",
      "portal_password",
    ],
    body: `Hi {first_name},

A very warm welcome to the Jinesis Lab! Here's how to get set up with the lab, which we would appreciate if you could do in the upcoming 5 days:

1. Member portal: Log into our lab portal {dashboard_url} using {member_email} and password {portal_password}. You should complete everything under "My Info", including your profile info, onboarding steps, time availability registration, and your project list.

2. Slack: You should have access to various channels in our Slack workspace. Day-to-day coordination happens there rather than over email.

3. Meetings: You may sometimes receive calendar invites for lab events. Two habits worth adopting early: (a) always RSVP on Google Calendar events, and (b) use the graphic interface of your calendar app (and we suggest Google Calendar), as meeting times may move spontaneously, and might need time-zone conversion including daylight savings.

4. Google Drive: your project folder is here: {drive_folder_link}. Please also read the short "Google file common practice" guide {drive_guide_link}; it keeps everyone's files findable.

5. Keep updated by following our social media accounts:

- LinkedIn: Zhijing-Jin, Jinesis-Lab, EuroSafeAI
- X / Twitter: ZhijingJin, JinesisLab, EuroSafeAI
- Subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com

If you spot errors for any of the above system automation, or have questions, please reply here, and we will be happy to help.

Best regards,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // Not a clone of the coauthor_major setup mail. A 5-10 h/week collaborator is onboarded to the
    // project rather than to the lab: no portal account, and the project folder reaches them
    // pinned in the Slack project channel rather than as a provisioned 1:1 workspace, which is why
    // this mail carries no {drive_folder_link}. The file-practice guide is `yes_separate` for this
    // subgroup in the access matrix, so it follows in its own mail rather than appearing here.
    id: "coauthor_minor",
    kind: "subgroup",
    subject: `Welcome to the Jinesis Lab: your onboarding steps`,
    required: ["first_name"],
    body: `Hi {first_name},

A very warm welcome to the Jinesis Lab! To facilitate our project collaboration, we recommend the following onboarding setup at the lab:

1. Slack: You will be invited to various channels in our workspace. Day-to-day coordination happens there rather than over email. Also, your main communication is to message in the group, or ask personal questions to your project lead or senior Jinesis members in our project.

2. Google Drive for Project Collaboration: For any research project in our lab, we have the practice of putting all project-related files in one project folder. This one will be pinned to your Slack project group chat. (Or please ask in the channel if you cannot see it in our group chat.)

3. Meetings: You may sometimes receive calendar invites for lab events. Two habits worth adopting early: (a) always RSVP on Google Calendar events, and (b) use the graphic interface of your calendar app (and we suggest Google Calendar), as meeting times may move spontaneously, and might need time-zone conversion including daylight savings.

4. Keep updated by following our social media accounts:

- LinkedIn: Zhijing-Jin, Jinesis-Lab, EuroSafeAI
- X / Twitter: ZhijingJin, JinesisLab, EuroSafeAI
- Subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com

If you spot errors for any of the above system automation, or have questions, please reply here, and we will be happy to help.

Best regards,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    id: "disappearing_coauthor",
    kind: "subgroup",
    subject: `Checking in about your Jinesis involvement`,
    required: ["first_name", "project_or_context"],
    body: `Hi {first_name},

We hope things are going well on your side. We have not heard from you for a while regarding {project_or_context} and wanted to check what level of involvement currently works for you.

One option is to move you to alumni status. This has no ongoing obligations: you remain on the newsletter and in #friends-and-collaborators, receive invites to dinners in your city, and stay connected to anything you have co-authored.

If you later have the capacity and interest to come back as a half-time or full-time collaborator, you'd be very welcome. You've already worked with us, so starting something new together would be easy.

Would alumni status suit you for now? A short reply is enough, and you are also very welcome to tell us if another arrangement would work better.

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
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
    required: ["drive_folder_link", "first_name"],
    body: `Hi {first_name},

A very warm welcome to the Jinesis Lab with Prof. Zhijing Jin! We are very happy to have you with us.

A few things to get you set up:

1. Member portal: Create your account at {dashboard_url}signup and complete "My Profile." Please include a personal email address that you expect to retain if your institutional affiliation changes.

2. Slack: Invitations to the workspace and your relevant channels are on their way. Most of our everyday conversation happens there.

3. Google Drive: Your shared project folder is here: {drive_folder_link}. All files related to the project will be stored and shared in this folder.

4. Keep updated by following our social media accounts:

- LinkedIn: Zhijing-Jin, Jinesis-Lab, EuroSafeAI
- X / Twitter: ZhijingJin, JinesisLab, EuroSafeAI
- Subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com

If an invitation has not arrived within a week, or if anything is unclear, please reply here, and we will be happy to help.

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    id: "own_pace_advisee_norms",
    kind: "supplement",
    subject: `How we work at Jinesis: communication and meetings`,
    required: ["drive_folder_link", "first_name"],
    body: `Hi {first_name},

We would like to share a few habits that help research collaborations run smoothly at Jinesis.

Please create your member-portal account at {dashboard_url}signup and update "My Profile" with your information.

Keep us updated regularly on Slack. Short, substantive updates work better than long ones: what you learned, what's still uncertain, what you plan to do next — no need to wait until you have enough for a full technical report.

Your shared project folder is here: {drive_folder_link}. We will store and share all project-related files through this folder.

Please communicate changes in your availability early. If coursework, co-supervision, travel, or anything else will affect your work, let us know roughly for how long and how you plan to adjust. It makes coordination much easier.

Keep updated by following our social media accounts:

- LinkedIn: Zhijing-Jin, Jinesis-Lab, EuroSafeAI
- X / Twitter: ZhijingJin, JinesisLab, EuroSafeAI
- Subscribe to our newsletter by emailing "subscribe" to jinesis+subscribe@googlegroups.com

We're glad to have you working with us and looking forward to seeing the project develop!

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    id: "coauthor_major_norms",
    kind: "supplement",
    subject: `Your project team at the Jinesis Lab`,
    required: ["contact_name", "first_name", "project_or_context", "team_lead_role"],
    body: `Hi {first_name},

We are delighted to have you on {project_or_context}. Here's how the team around you works.

Your project team. {contact_name} ({team_lead_role}) is your main contact for planning, implementation, and feedback. Zhijing stays closely involved in research direction, framing, major decisions, and final paper quality. Where you can, use the project channel rather than DMs, so everyone can weigh in.

Staying in sync. A short update in the project channel roughly every 10 hours of work is the rhythm we aim for: findings, decisions, next steps, blockers. Longer technical detail belongs in a shared document or a meeting.

Meetings. The Monday lab meeting is mandatory; the Wednesday themed meeting for your topic is highly recommended. Both are where shared practice around venues, submissions, authorship, and rebuttals gets passed on.

Logistics. For venue choice, authorship, deadlines, and reimbursements, the guidebook covers most of it. If your situation isn't in there, {contact_name} and the team are happy to help.

We are excited to work with you and see the project develop.

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // Carries one paragraph the coauthor_major version does not: at 5-10 h/week the split between
    // who drives the work and who advises it is the thing most often misread, so the roles are
    // named outright.
    id: "coauthor_minor_norms",
    kind: "supplement",
    subject: `Your project team at the Jinesis Lab`,
    required: [
      "contact_name",
      "first_name",
      "guidance_coauthors",
      "main_doers",
      "project_or_context",
      "recipient_role",
      "team_lead_role",
    ],
    body: `Hi {first_name},

We are delighted to have you on {project_or_context}. Here's how the team around you works.

Your project team. {contact_name} ({team_lead_role}) is your main contact for planning, implementation, and feedback. Zhijing stays closely involved in research direction, framing, major decisions, and final paper quality. Where you can, use the project channel rather than DMs, so everyone can weigh in.

Roles within the project. Your role is {recipient_role}. {main_doers} drive the day-to-day work, while {guidance_coauthors} provide timely guidance through fast replies and meetings requested up to two days in advance. Other coauthors contribute asynchronously through Slack, project documents, and the relevant Wednesday meeting.

Staying in sync. A short update in the project channel roughly every 10 hours of work is the rhythm we aim for: findings, decisions, next steps, blockers. Longer technical detail belongs in a shared document or a meeting.

Meetings. The Monday lab meeting is mandatory; the Wednesday themed meeting for your topic is highly recommended. Both are where shared practice around venues, submissions, authorship, and rebuttals gets passed on.

Logistics. For venue choice, authorship, deadlines, and reimbursements, the guidebook covers most of it. If your situation isn't in there, {contact_name} and the team are happy to help.

We are excited to work with you and see the project develop.

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    id: "disappearing_coauthor_paper",
    kind: "supplement",
    subject: `Next steps for {paper_short_title}`,
    required: ["delegate_name", "first_name", "paper_short_title", "paper_title", "reply_by_date"],
    body: `Hi {first_name},

We hope things are going well on your side. We would like to agree on how to move "{paper_title}" forward. Please choose one of the following arrangements:

1. Jinesis takes over the project. {delegate_name} becomes responsible for the day-to-day work and next submission steps. We will ask you to provide any files, context, or access needed for the handover.

2. You remain involved at key decision points. We handle the day-to-day work, while you commit to reviewing materials and responding by the agreed deadlines when we contact you about the venue, major revisions, or final sign-off.

We would appreciate it if you could reply by {reply_by_date} with your preferred option and any context we should know. If we do not hear from you by then, we will proceed with option 1.

Thank you again for your work on the paper!

Warmly,
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // An automatic decline: the access matrix makes this the standing answer for someone at
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
Jinesis Lab by Prof. Zhijing Jin`,
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
Jinesis Lab by Prof. Zhijing Jin`,
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
Jinesis Lab by Prof. Zhijing Jin`,
  },

  {
    // Deliberately light: an external professor fills in nothing, they only confirm what we hold.
    // Sent at onboarding and re-verified about every six months. Professional contact only --
    // WhatsApp is never requested from external professors, nor during onboarding generally.
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
Jinesis Lab by Prof. Zhijing Jin`,
  },
] as const satisfies readonly AdminBotOnboardingTemplate[];

export type AdminBotOnboardingTemplateId = (typeof ADMINBOT_ONBOARDING_TEMPLATES)[number]["id"];

export function findOnboardingTemplate(id: string): AdminBotOnboardingTemplate | undefined {
  return ADMINBOT_ONBOARDING_TEMPLATES.find((entry) => entry.id === id);
}
