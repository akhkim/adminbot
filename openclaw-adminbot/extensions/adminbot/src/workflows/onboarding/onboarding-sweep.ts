// Who is owed an onboarding mail this week, from the difference between the sheet and the database.
//
// The spreadsheet is where membership is decided: an admin adds a row when somebody joins and edits
// Member Type when what they are changes. Both of those should produce a mail, and until now
// neither did on its own -- joining was noticed by `planRosterSync` and reported, and a type change
// was applied to the database silently.
//
// The awkward part is *when* the difference is visible. `adminbot-roster-sync` runs at 06:10 daily
// and writes the sheet's Member Type onto the record, so by the time a weekly job looks, the two
// agree again and the change that should have sent a mail has been erased. So this reads two
// things and unions them:
//
//   - **Live mismatches** (`plan.member_type_changes`): the sheet and the database disagree right
//     now. This is what a first run sees, before any history exists, and it is what a later run
//     sees if the nightly sync failed or its size guard refused the pass.
//   - **Applied changes** (`roster_sync.member_type_changed` audit rows): the nightly sync already
//     reconciled it, and the audit line is the only surviving record that it ever differed.
//
// Neither alone is enough. The first misses every change the sync has already absorbed; the second
// is empty on the first run, which is exactly when the lab most needs the sweep to do something.
//
// Everything is deduplicated against a ledger of what has already been mailed, because the union
// above will legitimately report the same person twice -- once live, once from the audit row the
// sync wrote the next morning.
import type { AdminBotLabMember } from "../../contracts/actions.js";
import type { RosterAddition, RosterSyncPlan } from "../members/roster-sync.js";
import { templateForMemberType } from "./member-type-template.js";

/** One person to mail, and the template their Member Type picked. */
export type OnboardingMailTarget = {
  /** Absent for a joiner who has no record yet; `create` carries the row they came from. */
  member_id?: string;
  name: string;
  email: string;
  member_type: string;
  template_id: string;
  /** Why they are here, for the proposal summary an admin reads before approving. */
  reason: string;
};

/** A sheet row with nobody behind it, to be created before it can be mailed. */
export type OnboardingCreateTarget = {
  sheet_row: number;
  name: string;
  email: string;
  member_type: string;
  /** The id the member would be given, slugged from the name. */
  member_id: string;
};

export type OnboardingSweepPlan = {
  create: OnboardingCreateTarget[];
  mail: OnboardingMailTarget[];
  /** Reported rather than dropped: a row nobody mails is a row somebody should look at. */
  skipped: { name: string; reason: string }[];
};

/**
 * The id a joining row gets.
 *
 * Slugged from the name, matching the spelling the rest of the roster uses (`luke-zhang`). A row
 * whose name slugs to nothing, or collides with somebody already on the roster, is not created --
 * the first is unusable and the second is the duplicate case, which belongs on the sheet.
 */
export function memberIdForRow(name: string): string {
  return name
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function addressOf(row: RosterAddition): string {
  return (row.email ?? "").trim().toLowerCase();
}

export function planOnboardingSweep(params: {
  plan: RosterSyncPlan;
  /** `roster_sync.member_type_changed` rows since the last sweep, newest or oldest first. */
  appliedChanges: readonly { member_id: string; to: string }[];
  memberById: (memberId: string) => AdminBotLabMember | undefined;
  /**
   * What has already gone out, as `${email}:${template_id}`.
   *
   * Keyed on the address rather than the member id because that is what the existing ledger holds
   * -- `onboarding.guide_sent` records `{ template_id, recipient }` -- and because a joiner has no
   * member id until this sweep gives them one, so the address is the only key that spans both
   * halves of the plan.
   */
  alreadyMailed: ReadonlySet<string>;
  /** Every address the roster already holds, so a joining row cannot shadow an existing member. */
  knownMemberIds: ReadonlySet<string>;
}): OnboardingSweepPlan {
  const out: OnboardingSweepPlan = { create: [], mail: [], skipped: [] };
  const claimed = new Set<string>();

  const wants = (key: string) => !params.alreadyMailed.has(key) && !claimed.has(key);

  // Joiners first: a sheet row with nobody behind it. Created *and* mailed, which is the one place
  // this sweep writes a record rather than reading one.
  for (const row of params.plan.additions) {
    const email = addressOf(row);
    const memberId = memberIdForRow(row.name);
    const template = templateForMemberType(row.member_type);
    if (!email) {
      out.skipped.push({ name: row.name, reason: `sheet row ${row.sheet_row} has no email` });
      continue;
    }
    if (!memberId) {
      out.skipped.push({ name: row.name, reason: `sheet row ${row.sheet_row} has no usable name` });
      continue;
    }
    if (params.knownMemberIds.has(memberId)) {
      // The id is taken but the addresses did not match, which is how `planRosterSync` decided this
      // was an addition. Two records for one person, or two people with one name -- either way a
      // human decides, because creating over the top would merge two people silently.
      out.skipped.push({
        name: row.name,
        reason: `member id "${memberId}" already exists but the sheet address does not match it`,
      });
      continue;
    }
    if (!template.ok) {
      out.skipped.push({ name: row.name, reason: template.reason });
      continue;
    }
    const key = `${email}:${template.templateId}`;
    if (!wants(key)) {
      continue;
    }
    claimed.add(key);
    out.create.push({
      sheet_row: row.sheet_row,
      name: row.name,
      email,
      member_type: row.member_type,
      member_id: memberId,
    });
    out.mail.push({
      member_id: memberId,
      name: row.name,
      email,
      member_type: row.member_type,
      template_id: template.templateId,
      reason: `joined on sheet row ${row.sheet_row}`,
    });
  }

  // Type changes, from both directions. Live mismatches carry the sheet's answer in `to`; the audit
  // rows carry the same field, written when the sync applied it.
  const changes = [
    ...params.plan.member_type_changes.map((change) => ({
      member_id: change.member_id,
      to: change.to,
      reason: `Member Type on the sheet says "${change.to}", the record says "${change.from ?? "nothing"}"`,
    })),
    ...params.appliedChanges.map((change) => ({
      member_id: change.member_id,
      to: change.to,
      reason: `Member Type changed to "${change.to}"`,
    })),
  ];
  for (const change of changes) {
    const member = params.memberById(change.member_id);
    if (!member) {
      out.skipped.push({ name: change.member_id, reason: "no member record" });
      continue;
    }
    const template = templateForMemberType(change.to);
    if (!template.ok) {
      out.skipped.push({ name: member.name ?? change.member_id, reason: template.reason });
      continue;
    }
    const email = (member.email ?? member.correspondence_email ?? "").trim().toLowerCase();
    if (!email) {
      out.skipped.push({ name: member.name ?? change.member_id, reason: "no email on file" });
      continue;
    }
    const key = `${email}:${template.templateId}`;
    if (!wants(key)) {
      continue;
    }
    claimed.add(key);
    out.mail.push({
      member_id: change.member_id,
      name: member.name ?? change.member_id,
      email,
      member_type: change.to,
      template_id: template.templateId,
      reason: change.reason,
    });
  }
  return out;
}
