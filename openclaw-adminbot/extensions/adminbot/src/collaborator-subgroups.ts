import type {
  AdminBotExternalCollaboratorSubgroup,
  AdminBotLabMember,
  AdminBotPrivilegeLevel,
} from "./contracts.js";

// The document the `yes_separate` follow-up email tells the person to read; the skill's
// separate-delivery template links the same doc. Defined once so surfaces do not carry copies.
export const ADMINBOT_SEPARATE_DELIVERY_DOC_URL =
  "https://docs.google.com/document/d/1a_dXeLLPWlXK39PE5uj3qDWewO7pG5tr63pc0VP60SM/edit?tab=t.0";

// The lab's matrix does not answer every cell with yes/no: two rows oblige a separate email
// telling the person to read ADMINBOT_SEPARATE_DELIVERY_DOC_URL, one cell is still unconfirmed,
// and the rec-letter row has two answers that are neither. Collapsing these to booleans would
// drop the instruction the agent has to follow.
export const adminBotCollaboratorAccessCells = [
  "yes",
  "no",
  // Granted, but only by a separate email pointing at ADMINBOT_SEPARATE_DELIVERY_DOC_URL.
  "yes_separate",
  "pending",
  "case_by_case",
  "auto_decline",
] as const;

export type AdminBotCollaboratorAccessCell = (typeof adminBotCollaboratorAccessCells)[number];

export type AdminBotCollaboratorGrantedCell = Exclude<AdminBotCollaboratorAccessCell, "no">;

// Only granted cells are listed per item; a subgroup missing from `cells` is "no".
type AccessItemDefinition = {
  id: string;
  label: string;
  detail: string;
  cells: Partial<Record<AdminBotExternalCollaboratorSubgroup, AdminBotCollaboratorGrantedCell>>;
};

const ACCESS_ITEMS = [
  {
    id: "spreadsheet_full_details",
    label: "Full back-end spreadsheet profile",
    detail: "Profile in our back-end spreadsheet in full details.",
    cells: { alumni: "yes", coauthor_minor: "yes", coauthor_major: "yes" },
  },
  {
    id: "spreadsheet_basic",
    label: "Basic back-end spreadsheet entry",
    detail:
      "Back-end spreadsheet: store their email plus a rough tldr background (PhD, Prof, ... intersecting with us for XX).",
    cells: {
      slightly_better_than_emails: "yes",
      acquaintance: "yes",
      coauthor_minor: "yes",
      disappearing_coauthor: "yes",
      external_prof: "yes",
    },
  },
  {
    id: "welcome_linkedin_twitter",
    label: "LinkedIn and Twitter follow welcome",
    detail: "Welcome LinkedIn and Twitter followings.",
    cells: {
      interviewee: "yes",
      acquaintance: "yes",
      alumni: "yes",
      coauthor_minor: "yes",
      coauthor_major: "yes",
    },
  },
  {
    id: "welcome_newsletter",
    label: "Newsletter and other follow welcome",
    detail: "Welcome newsletter subscriptions and all other types of followings.",
    cells: { alumni: "yes", coauthor_minor: "yes", coauthor_major: "yes" },
  },
  {
    id: "time_plan_confirmation_emails",
    label: "Time-plan confirmation emails",
    detail:
      "Send emails to confirm their time plan (let them use Luke's function and share with Zhijing on Slack or email).",
    cells: { disappearing_coauthor: "yes" },
  },
  {
    id: "adminbot_portal_access",
    label: "AdminBot portal access",
    detail: "Have AdminBot portal access.",
    cells: { alumni: "yes", coauthor_major: "yes" },
  },
  {
    id: "slack_guest_space_check",
    label: "Slack guest space check",
    detail:
      "Issue a check condition: if they do not have the main Slack space, link to the Jinesis free Slack space for the slack-guest-chat group in DCS with the interviewer and project collaborators they can chat with.",
    cells: { interviewee: "yes" },
  },
  {
    id: "slack_connect_friends_channel",
    label: "#friends-and-collaborators via Slack Connect",
    detail: "Join Jinesis #friends-and-collaborators through Slack Connect.",
    cells: {
      acquaintance: "yes",
      alumni: "yes",
      coauthor_minor: "yes",
      coauthor_major: "yes",
      disappearing_coauthor: "yes",
      external_prof: "yes",
    },
  },
  {
    id: "active_channels",
    label: "#jinesis-active and #random-active",
    detail: "Add them to #jinesis-active and #random-active, both channels.",
    cells: { coauthor_minor: "yes", coauthor_major: "yes" },
  },
  {
    id: "slack_guest_chat_zhijing",
    label: "Slack guest chat with Zhijing and team",
    detail: "Slack-guest-chat with Zhijing and the team lead or collaborator.",
    cells: { interviewee: "yes", slightly_better_than_emails: "yes" },
  },
  {
    id: "discussion_channel",
    label: "#discussion-xxx topic channel",
    detail: "Add to #discussion-xxx for joining the discussions on this broad topic.",
    cells: { coauthor_minor: "yes", coauthor_major: "yes" },
  },
  {
    id: "project_channel",
    label: "#proj-xxx project channel",
    detail:
      "Add to the #proj-xxx channel so we can chat with this person on this specific project.",
    cells: { interviewee: "pending", coauthor_minor: "yes", coauthor_major: "yes" },
  },
  {
    id: "project_drive_folder",
    label: "Project Google Drive folder",
    detail:
      "Has access to our project-related Google Drive folder (or create it if it does not exist).",
    cells: {
      interviewee: "yes",
      slightly_better_than_emails: "yes",
      acquaintance: "yes",
      coauthor_minor: "yes",
      coauthor_major: "yes",
    },
  },
  {
    id: "weekly_meeting",
    label: "Weekly meeting channel and invite",
    detail:
      "Add to Slack channel #meeting-xxx for the weekly meeting and to the Wednesday themed meeting's calendar invite. Whoever is on our calendar invite is repeatedly reminded to use the Google Calendar app interface with alerts and to ignore calendar-related emails, because of the time zones and spontaneous moves of meetings.",
    cells: { coauthor_major: "yes" },
  },
  {
    id: "spreadsheet_whatsapp_personal_email",
    label: "WhatsApp and personal email on file",
    detail:
      "In our back-end spreadsheet, store their WhatsApp plus personal email (invariant to graduation), e.g. for paper resubmission.",
    cells: { alumni: "yes", disappearing_coauthor: "yes" },
  },
  {
    id: "newcomer_drive_practice",
    label: "Newcomer Drive practice walkthrough",
    detail:
      "If newly joined (history less than 3 months), introduce the more detailed Google Drive practice.",
    cells: { coauthor_minor: "yes", coauthor_major: "yes" },
  },
  {
    id: "google_file_practice_guide",
    label: "Google file common practice guide",
    detail: "Send the guide of 'google file common practice'.",
    cells: { coauthor_minor: "yes_separate", coauthor_major: "yes" },
  },
  {
    id: "what_to_expect_stories",
    label: "'What to Expect' handbook stories",
    detail: "Compose stories for the 'What to Expect' handbook about the communication protocols.",
    cells: { interviewee: "yes_separate", coauthor_minor: "yes_separate", coauthor_major: "yes" },
  },
  {
    id: "backend_email_triggers",
    label: "Back-end email triggers",
    detail:
      "Allow email triggers in the backend for 'paper submission / resubmission', 'social media draft sharing', etc. Data structure: user_id plus a set of proj_id.",
    cells: { external_prof: "yes" },
  },
  {
    id: "rec_letter_button",
    label: "Recommendation letter button",
    detail: "Rec letter button on their profile.",
    cells: {
      alumni: "yes",
      coauthor_minor: "case_by_case",
      coauthor_major: "yes",
      disappearing_coauthor: "auto_decline",
    },
  },
  {
    id: "vector_roster_share",
    label: "Vector sponsor roster share",
    detail:
      "On the constantly-updating name + institutional-email sheet auto-shared with our Vector sponsor contact, who reads it to decide whether to extend or remove an account. Full members are on it too, by privilege level rather than subgroup — see vectorSponsorRoster.",
    cells: { coauthor_major: "yes" },
  },
  {
    id: "city_dinner_invite",
    label: "City-based dinner or team building invite",
    detail: "Invite to city-based dinners and team building events.",
    cells: {
      interviewee: "yes",
      acquaintance: "yes",
      alumni: "yes",
      coauthor_minor: "yes",
      coauthor_major: "yes",
    },
  },
] as const satisfies readonly AccessItemDefinition[];

export type AdminBotCollaboratorAccessItemId = (typeof ACCESS_ITEMS)[number]["id"];

export type AdminBotCollaboratorGrant = {
  item: AdminBotCollaboratorAccessItemId;
  label: string;
  detail: string;
  cell: AdminBotCollaboratorGrantedCell;
};

/** Access items granted to a subgroup, in matrix row order. Ungranted rows are omitted. */
export function collaboratorSubgroupAccess(
  subgroup: AdminBotExternalCollaboratorSubgroup,
): AdminBotCollaboratorGrant[] {
  const grants: AdminBotCollaboratorGrant[] = [];
  for (const item of ACCESS_ITEMS) {
    // Widen the frozen literal shape so an ungranted subgroup reads as undefined instead of
    // failing to index; the literal type is still what `AdminBotCollaboratorAccessItemId` derives from.
    const cells: AccessItemDefinition["cells"] = item.cells;
    const cell = cells[subgroup];
    if (cell) {
      grants.push({ item: item.id, label: item.label, detail: item.detail, cell });
    }
  }
  return grants;
}

// The `vector_roster_share` row is the one item whose population crosses both axes: the sponsor
// sheet carries internal lab members by privilege level plus external collaborators in the
// coauthor_major subgroup. Admins are on it because they are lab people who hold Vector accounts —
// leaving them off would have the sponsor read their absence as "remove this account".
const VECTOR_ROSTER_PRIVILEGE_LEVELS: readonly AdminBotPrivilegeLevel[] = ["member", "admin"];

export type AdminBotVectorRosterEntry = {
  id: string;
  name: string;
  email: string;
};

export type AdminBotVectorRoster = {
  entries: AdminBotVectorRosterEntry[];
  // Ids that belong on the sheet but have no email to put there. Reported rather than dropped
  // silently: an omitted person reads to the sponsor as an account to remove.
  missing_email: string[];
};

/**
 * Who belongs on the Vector sponsor sheet: name and institutional email only, nothing else about
 * the person. Sorted by name then id so the shared sheet does not churn between refreshes.
 */
export function vectorSponsorRoster(members: readonly AdminBotLabMember[]): AdminBotVectorRoster {
  const entries: AdminBotVectorRosterEntry[] = [];
  const missingEmail: string[] = [];
  for (const member of members) {
    const onRoster =
      VECTOR_ROSTER_PRIVILEGE_LEVELS.includes(member.privilege_level) ||
      (member.privilege_level === "external_collaborator" &&
        member.collaborator_subgroup === "coauthor_major");
    if (!onRoster) {
      continue;
    }
    const email = member.email?.trim();
    if (!email) {
      missingEmail.push(member.id);
      continue;
    }
    entries.push({ id: member.id, name: member.name, email });
  }
  entries.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  missingEmail.sort((left, right) => left.localeCompare(right));
  return { entries, missing_email: missingEmail };
}
