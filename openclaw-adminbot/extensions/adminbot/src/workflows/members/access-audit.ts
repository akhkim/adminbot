/**
 * Did onboarding actually do what the access matrix says it should have?
 *
 * `collaborator-subgroups.ts` is the *policy*: which access items each kind of collaborator is
 * entitled to. This is the *audit*: for one person, item by item, whether there is evidence the
 * lab actually carried it out. The two are deliberately separate files -- a matrix that graded
 * itself would always pass.
 *
 * Three things this is careful about, because getting any of them wrong makes the report worse
 * than no report:
 *
 *   - "No evidence" is not "not done". Half these rows (welcoming somebody on LinkedIn, composing
 *     a "What to Expect" story) leave no machine-readable trace anywhere, and a checker that
 *     scored them as failures would bury the rows that genuinely are. They report `unverifiable`
 *     with the reason, and they are counted separately from failures.
 *   - "Attempted and failed" is not the same as "never attempted". The audit trail distinguishes
 *     them -- `auth.calendar_invite_failed` is a different row from no row at all -- and so does
 *     this, because they need different fixes: one is a broken connector, the other is a member
 *     who never went through onboarding.
 *   - An item nobody is entitled to is `not_applicable`, never a silent pass. A pass that means
 *     "we did not have to do anything" and a pass that means "we did it" cannot share a symbol.
 *
 * Pure: every input arrives in `AccessAuditEvidence`, gathered by the caller from wherever it
 * lives (the roster, the audit log, the Slack export). That keeps the rules testable without a
 * database, a Slack token, or a spreadsheet.
 */
import type {
  AdminBotExternalCollaboratorSubgroup,
  AdminBotLabMember,
} from "../../contracts/actions.js";
import {
  type AdminBotCollaboratorAccessItemId,
  type AdminBotCollaboratorGrantedCell,
  adminBotCollaboratorAccessItems,
} from "./collaborator-subgroups.js";

export type AccessAuditVerdict =
  /** Evidence the item was carried out. */
  | "pass"
  /** Evidence it was not: an attempt that failed, or a surface that should show it and does not. */
  | "fail"
  /** Entitled to it, but nothing in reach records whether it happened. */
  | "unverifiable"
  /** Not entitled to it, so there is nothing to check. */
  | "not_applicable";

export type AccessAuditFinding = {
  item: AdminBotCollaboratorAccessItemId;
  label: string;
  /** The matrix cell behind the entitlement; absent when the person is not entitled at all. */
  cell?: AdminBotCollaboratorGrantedCell;
  verdict: AccessAuditVerdict;
  /** One line, in the words the report prints. Always set, including on a pass. */
  detail: string;
};

export type AccessAuditRow = {
  member_id: string;
  member_name: string;
  /** What the audit graded against, and how it got there -- see `resolveSubgroup`. */
  subgroup?: AdminBotExternalCollaboratorSubgroup;
  subgroup_source: "record" | "member_type" | "full_member" | "unknown";
  member_type?: string;
  findings: AccessAuditFinding[];
};

/**
 * What onboarding left behind for one person, gathered from every source in reach.
 *
 * Everything is optional-shaped rather than optional: a caller that cannot reach Slack passes an
 * empty channel list *and* says so through `slack_export_available`, so the audit can tell "this
 * person is in no channels" from "nobody asked Slack". The first is a failure; the second is not
 * a finding about the member at all.
 */
export type AccessAuditEvidence = {
  /** Channel names (no leading #) this member belongs to, from the Slack member export. */
  slack_channels: readonly string[];
  /** Whether the Slack export was loaded at all. False makes every Slack row unverifiable. */
  slack_export_available: boolean;
  /** Whether the roster knows a Slack account for them -- the precondition for every channel row. */
  slack_account_known: boolean;
  /** They can sign in to the portal: a credential row exists. */
  portal_credential: boolean;
  /** Latest outcome of each onboarding side effect, from the audit trail. */
  calendar_invite: AccessAuditAttempt;
  dcs_form: AccessAuditAttempt;
  approval_email: AccessAuditAttempt;
  onboarding_guide: AccessAuditAttempt;
  /** Whether the audit trail was loaded. False makes every trail-backed row unverifiable. */
  audit_trail_available: boolean;
};

/** Three-state outcome of a side effect the audit trail records both halves of. */
export type AccessAuditAttempt = "succeeded" | "failed" | "no_record";

/**
 * Which subgroup's row of the matrix to grade this person against.
 *
 * `collaborator_subgroup` is the field the matrix is keyed on, and on the live roster it is unset
 * on every row -- so grading on it alone would report the entire lab as entitled to nothing. The
 * `member_type` column is what the onboarding spreadsheet actually fills in, and its tokens map
 * onto the subgroups one-for-one, so it is the fallback.
 *
 * The fallback is reported (`subgroup_source`) rather than hidden, because the two disagreeing --
 * or the record being blank where the sheet is not -- is itself a finding: it means the matrix is
 * being applied to a field nothing populates.
 */
export function resolveSubgroup(member: AdminBotLabMember): {
  subgroup?: AdminBotExternalCollaboratorSubgroup;
  source: AccessAuditRow["subgroup_source"];
} {
  if (member.collaborator_subgroup) {
    return { subgroup: member.collaborator_subgroup, source: "record" };
  }
  const tokens = new Set(
    (member.member_type ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  // Most-committed first, matching templateForMemberType: somebody who is both `full` and
  // `coauthor-major` is graded as the lab member they are, whose onboarding covers the other.
  if (tokens.has("full")) {
    return { source: "full_member" };
  }
  for (const [token, subgroup] of SUBGROUP_BY_TOKEN) {
    if (tokens.has(token)) {
      return { subgroup, source: "member_type" };
    }
  }
  return { source: "unknown" };
}

// The member-type tokens the onboarding sheet uses, and the subgroup row each grades against.
// Ordered most-committed first for the same reason TEMPLATE_BY_TYPE is.
const SUBGROUP_BY_TOKEN: readonly (readonly [string, AdminBotExternalCollaboratorSubgroup])[] = [
  ["coauthor-major", "coauthor_major"],
  ["own-pace-advisee", "own_pace_advisee"],
  ["coauthor-minor", "coauthor_minor"],
  ["coauthor-discussant-or-designer", "coauthor_discussant_designer"],
  ["disappearing-coauthor", "disappearing_coauthor"],
  ["external-prof", "external_prof"],
  ["alumni", "alumni"],
  ["interviewee", "interviewee"],
  ["slightly-better-than-emails", "slightly_better_than_emails"],
  ["acquaintance", "acquaintance"],
];

/** The Slack Connect room the matrix calls #friends-and-collaborators, as the export names it. */
const FRIENDS_CHANNELS = [
  "jinesis-with-friends-and-collaborators",
  "jinesis-friends",
  "general-channel-with-external-collaborators-and-alumni",
];

const ACTIVE_CHANNELS = ["jinesis-active", "random-active"];

/** Member types the Vector sponsor roster is actually built from. See VECTOR_ROSTER_MEMBER_TYPES. */
const VECTOR_ROSTER_TOKENS = ["full", "coauthor-major"];

/**
 * How to check one matrix row, or why it cannot be checked.
 *
 * A `null` check is the honest answer for a row whose execution leaves no trace anywhere the lab
 * can read: following somebody on LinkedIn, composing a handbook story, telling somebody about
 * Drive conventions on a call. The reason is carried so the report can say *why* it is silent
 * rather than leaving a blank the reader has to interpret.
 */
type AccessItemCheck =
  | { kind: "unverifiable"; reason: string }
  | {
      kind: "check";
      run: (evidence: AccessAuditEvidence, member: AdminBotLabMember) => AccessAuditFinding_Result;
    };

type AccessAuditFinding_Result = {
  verdict: Exclude<AccessAuditVerdict, "not_applicable">;
  detail: string;
};

function hasAny(channels: readonly string[], wanted: readonly string[]): boolean {
  const held = new Set(channels.map((name) => name.trim().toLowerCase()));
  return wanted.some((name) => held.has(name));
}

function matching(channels: readonly string[], prefix: string): string[] {
  return channels
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.startsWith(prefix));
}

/** A Slack row: unverifiable without an export, a failure without an account, else the predicate. */
function slackCheck(
  describe: string,
  run: (channels: readonly string[]) => { ok: boolean; detail: string },
): AccessItemCheck {
  return {
    kind: "check",
    run: (evidence) => {
      if (!evidence.slack_export_available) {
        return { verdict: "unverifiable", detail: "no Slack export loaded" };
      }
      if (!evidence.slack_account_known) {
        return { verdict: "fail", detail: `no Slack account on file, so ${describe} cannot exist` };
      }
      const result = run(evidence.slack_channels);
      return { verdict: result.ok ? "pass" : "fail", detail: result.detail };
    },
  };
}

/** A row backed by the audit trail's succeeded/failed pair. */
function attemptCheck(
  pick: (evidence: AccessAuditEvidence) => AccessAuditAttempt,
  label: string,
): AccessItemCheck {
  return {
    kind: "check",
    run: (evidence) => {
      if (!evidence.audit_trail_available) {
        return { verdict: "unverifiable", detail: "no audit trail loaded" };
      }
      const attempt = pick(evidence);
      if (attempt === "succeeded") {
        return { verdict: "pass", detail: `${label} recorded as sent` };
      }
      if (attempt === "failed") {
        // Deliberately distinct from "no record": this one has a broken connector behind it, and
        // the fix is to that connector rather than to this member's onboarding.
        return { verdict: "fail", detail: `${label} was attempted and FAILED` };
      }
      return { verdict: "fail", detail: `no ${label} recorded` };
    },
  };
}

const CHECKS: Record<AdminBotCollaboratorAccessItemId, AccessItemCheck> = {
  spreadsheet_full_details: {
    kind: "check",
    run: (_evidence, member) => {
      // The rows the matrix means by "in full details": how to reach them, and what they work on.
      const missing = (
        [
          ["correspondence email", member.correspondence_email ?? member.email],
          ["location", member.location],
          ["research topics", member.research_topics?.length ? "y" : ""],
          ["joined month", member.joined_month],
        ] as const
      )
        .filter(([, value]) => !String(value ?? "").trim())
        .map(([field]) => field);
      return missing.length === 0
        ? { verdict: "pass", detail: "full profile on file" }
        : { verdict: "fail", detail: `profile missing: ${missing.join(", ")}` };
    },
  },
  spreadsheet_basic: {
    kind: "check",
    run: (_evidence, member) => {
      const email = (member.correspondence_email ?? member.email ?? "").trim();
      const tldr = (member.notes ?? member.research_branch ?? "").trim();
      if (!email) {
        return { verdict: "fail", detail: "no email on file" };
      }
      return tldr
        ? { verdict: "pass", detail: "email and background on file" }
        : { verdict: "fail", detail: "email on file but no background tldr" };
    },
  },
  welcome_linkedin_twitter: {
    kind: "unverifiable",
    reason: "following somebody leaves no record the lab can read back",
  },
  welcome_newsletter: {
    kind: "unverifiable",
    reason: "newsletter subscription is held by the mailing tool, not by AdminBot",
  },
  time_plan_confirmation_emails: {
    kind: "unverifiable",
    reason: "sent by hand; no email effect is recorded for it",
  },
  adminbot_portal_access: {
    kind: "check",
    run: (evidence) =>
      evidence.portal_credential
        ? { verdict: "pass", detail: "portal account exists" }
        : { verdict: "fail", detail: "no portal credential, so they cannot sign in" },
  },
  trusted_lab_private_info: {
    kind: "unverifiable",
    reason: "unanswered in the access-design sheet, so there is no rule to check against",
  },
  slack_guest_space_check: {
    kind: "check",
    run: (evidence) =>
      evidence.slack_account_known
        ? { verdict: "pass", detail: "has a Slack account, so the guest-space fallback is moot" }
        : {
            verdict: "fail",
            detail: "no Slack account on file and no record of the guest-space link being sent",
          },
  },
  slack_connect_friends_channel: slackCheck("the friends-and-collaborators channel", (channels) => {
    const ok = hasAny(channels, FRIENDS_CHANNELS);
    return {
      ok,
      detail: ok ? "in the friends-and-collaborators channel" : "not in any friends channel",
    };
  }),
  active_channels: slackCheck("#jinesis-active and #random-active", (channels) => {
    const held = new Set(channels.map((name) => name.trim().toLowerCase()));
    const missing = ACTIVE_CHANNELS.filter((name) => !held.has(name));
    return {
      ok: missing.length === 0,
      detail: missing.length === 0 ? "in both active channels" : `missing #${missing.join(", #")}`,
    };
  }),
  slack_guest_chat_zhijing: {
    kind: "unverifiable",
    reason: "a group DM, which the member export does not list",
  },
  discussion_channel: slackCheck("a #discussion- channel", (channels) => {
    const found = matching(channels, "discussion");
    return {
      ok: found.length > 0,
      detail: found.length > 0 ? `in ${found.length} discussion channel(s)` : "in no #discussion-",
    };
  }),
  project_channel: slackCheck("a #proj- channel", (channels) => {
    const found = matching(channels, "proj-");
    return {
      ok: found.length > 0,
      detail: found.length > 0 ? `in ${found.length} project channel(s)` : "in no #proj- channel",
    };
  }),
  project_drive_folder: {
    kind: "unverifiable",
    reason: "needs a live Drive permissions read; not in the roster or the Slack export",
  },
  weekly_meeting: slackCheck("a #meeting- channel", (channels) => {
    const found = matching(channels, "meeting-");
    return {
      ok: found.length > 0,
      detail:
        found.length > 0
          ? `in ${found.length} meeting channel(s); calendar invite not checked here`
          : "in no #meeting- channel",
    };
  }),
  spreadsheet_whatsapp_personal_email: {
    kind: "check",
    run: (_evidence, member) => {
      // The row asks for a personal address that survives graduation. WhatsApp is deliberately not
      // required -- onboarding never asks for it (see the item's own detail).
      const personal = (member.correspondence_email ?? "").trim();
      return personal
        ? { verdict: "pass", detail: "personal correspondence email on file" }
        : { verdict: "fail", detail: "no personal correspondence email on file" };
    },
  },
  newcomer_drive_practice: {
    kind: "unverifiable",
    reason: "a walkthrough given by a person; nothing records that it happened",
  },
  google_file_practice_guide: attemptCheck(
    (evidence) => evidence.onboarding_guide,
    "onboarding guide",
  ),
  what_to_expect_stories: {
    kind: "unverifiable",
    reason: "handbook prose; delivery is by a separate email nothing records per member",
  },
  backend_email_triggers: {
    kind: "unverifiable",
    reason: "no per-member trigger registry exists yet (the row asks for user_id + proj_id set)",
  },
  rec_letter_button: {
    kind: "unverifiable",
    reason: "the button is rendered from the subgroup at read time; nothing is executed to check",
  },
  vector_roster_share: {
    kind: "check",
    run: (_evidence, member) => {
      const tokens = (member.member_type ?? "").toLowerCase();
      const onIt = VECTOR_ROSTER_TOKENS.some((token) => tokens.includes(token));
      const email = (member.email ?? "").trim();
      if (!onIt) {
        // The matrix grants this to own_pace_advisee; vectorSponsorRoster does not include them.
        // That contradiction is documented in collaborator-subgroups.ts and is a live question,
        // so it is reported as a mismatch rather than graded either way.
        return {
          verdict: "fail",
          detail: "granted by the matrix but excluded by VECTOR_ROSTER_MEMBER_TYPES",
        };
      }
      return email
        ? { verdict: "pass", detail: "member type puts them on the sponsor roster" }
        : { verdict: "fail", detail: "on the sponsor roster by type but has no email to share" };
    },
  },
  city_dinner_invite: slackCheck("a #group- city channel", (channels) => {
    const found = matching(channels, "group-");
    return {
      ok: found.length > 0,
      detail: found.length > 0 ? `in ${found.length} group channel(s)` : "in no #group- channel",
    };
  }),
};

/**
 * The onboarding side effects every member goes through, whatever the matrix says.
 *
 * Separate from the matrix rows because they are not per-subgroup entitlements -- they are what
 * `approveRegistration` fires for anybody it approves. A full member has no subgroup row at all,
 * so without these the audit would have nothing to say about the largest group on the roster.
 */
const BASELINE_ITEMS = [
  {
    id: "baseline_approval_email" as const,
    label: "Account-approved email",
    check: attemptCheck((evidence) => evidence.approval_email, "account-approved email"),
  },
  {
    id: "baseline_calendar_invite" as const,
    label: "Lab calendar reader invite",
    check: attemptCheck((evidence) => evidence.calendar_invite, "lab calendar invite"),
  },
  {
    id: "baseline_dcs_form" as const,
    label: "DCS Slack-access form",
    check: attemptCheck((evidence) => evidence.dcs_form, "DCS form submission"),
  },
  {
    id: "baseline_portal_login" as const,
    label: "Portal sign-in credential",
    check: CHECKS.adminbot_portal_access,
  },
];

export type AccessAuditBaselineItemId = (typeof BASELINE_ITEMS)[number]["id"];

/**
 * Grade one member against every row they are entitled to, plus the baseline every account gets.
 *
 * Rows they are not entitled to are still emitted, as `not_applicable`. Dropping them would make
 * the report's shape depend on the subgroup, and the thing a reader most often wants to confirm is
 * that somebody is *not* on a surface -- which is invisible if the row is absent.
 */
export function auditMemberAccess(
  member: AdminBotLabMember,
  evidence: AccessAuditEvidence,
): AccessAuditRow {
  const { subgroup, source } = resolveSubgroup(member);
  const findings: AccessAuditFinding[] = [];

  for (const item of BASELINE_ITEMS) {
    findings.push({
      item: item.id as unknown as AdminBotCollaboratorAccessItemId,
      label: item.label,
      ...runCheck(item.check, evidence, member),
    });
  }

  for (const item of adminBotCollaboratorAccessItems) {
    const cells: Partial<
      Record<AdminBotExternalCollaboratorSubgroup, AdminBotCollaboratorGrantedCell>
    > = item.cells;
    const cell = subgroup ? cells[subgroup] : undefined;
    if (!cell) {
      findings.push({
        item: item.id,
        label: item.label,
        verdict: "not_applicable",
        detail: subgroup
          ? `not granted to ${subgroup}`
          : source === "full_member"
            ? "full member; the collaborator matrix does not apply"
            : "no subgroup resolved, so no matrix row applies",
      });
      continue;
    }
    // `auto_decline` is a grant to refuse something, and `case_by_case` is a grant to decide later.
    // Neither is an action with an outcome to look for, so neither is graded.
    if (cell === "auto_decline" || cell === "case_by_case" || cell === "pending") {
      findings.push({
        item: item.id,
        label: item.label,
        cell,
        verdict: "unverifiable",
        detail: `matrix cell is "${cell}", which is a decision rather than an action`,
      });
      continue;
    }
    findings.push({
      item: item.id,
      label: item.label,
      cell,
      ...runCheck(CHECKS[item.id], evidence, member),
    });
  }

  return {
    member_id: member.id,
    member_name: member.name,
    ...(subgroup ? { subgroup } : {}),
    subgroup_source: source,
    ...(member.member_type ? { member_type: member.member_type } : {}),
    findings,
  };
}

function runCheck(
  check: AccessItemCheck,
  evidence: AccessAuditEvidence,
  member: AdminBotLabMember,
): AccessAuditFinding_Result {
  return check.kind === "unverifiable"
    ? { verdict: "unverifiable", detail: check.reason }
    : check.run(evidence, member);
}

export type AccessAuditSummary = Record<AccessAuditVerdict, number> & {
  members: number;
  /** Members with at least one `fail`. The number the report leads with. */
  members_with_failures: number;
};

export function summarizeAccessAudit(rows: readonly AccessAuditRow[]): AccessAuditSummary {
  const summary: AccessAuditSummary = {
    pass: 0,
    fail: 0,
    unverifiable: 0,
    not_applicable: 0,
    members: rows.length,
    members_with_failures: 0,
  };
  for (const row of rows) {
    let failed = false;
    for (const finding of row.findings) {
      summary[finding.verdict] += 1;
      failed ||= finding.verdict === "fail";
    }
    if (failed) {
      summary.members_with_failures += 1;
    }
  }
  return summary;
}
