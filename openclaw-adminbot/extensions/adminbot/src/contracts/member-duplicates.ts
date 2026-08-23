// Finding the same person twice on the roster, and deciding what one record out of two looks like.
//
// The lab's roster has two ingestion paths and they do not agree on names. The Quick-Start survey
// writes a full name and the career detail behind it ("Terry Jingchen Zhang", MSc at ETH, no Slack
// id); the Slack member export writes whatever the workspace profile says and the account facts
// behind that ("Terry Zhang", a cs.toronto address, U09QKBM74M6, no role). Neither is wrong and
// neither is complete, so a person who arrived down both paths ends up as two half-records that
// each look like a lonely gap on the page they are read from.
//
// Both halves of the problem live here, and deliberately so: what counts as the same person, and
// what the merged record contains, are the two questions an admin is answering when they press
// Merge, and they should be answerable from one file rather than from a service method.
//
// Nothing here writes. `planMemberMerge` returns the patch and the conflicts; the service applies
// it and repoints the rows that name the record being retired.
import { isSamePerson, normalizePersonName } from "./person-names.js";

/** Why two records look like one person. Shown to the admin, never acted on automatically. */
export type MemberDuplicateReason =
  | "same_name"
  | "name_contains"
  | "same_email"
  | "same_slack_user_id";

export type MemberDuplicatePair<T> = {
  left: T;
  right: T;
  reasons: MemberDuplicateReason[];
  /**
   * `high` when an account fact matches -- an email or a Slack id is issued to one person, so two
   * records carrying the same one are the same person. `likely` when only the names line up,
   * which is a judgement a human still has to make: two people really can share a name.
   */
  confidence: "high" | "likely";
};

type DuplicateCandidate = {
  id: string;
  name?: string;
  email?: string;
  correspondence_email?: string;
  slack_user_id?: string;
};

function emails(member: DuplicateCandidate): string[] {
  return [member.email, member.correspondence_email]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
}

/**
 * One name's tokens contained in the other's, sharing a surname.
 *
 * `isSamePerson` covers the common case (a middle name on one side only) but requires the first
 * token to match, so it cannot see "Alice Yuchen Zhang" and "Yuchen Zhang" -- an English given
 * name on one record and not the other. This rule reads the tokens as a set instead: every token
 * of the shorter name appears in the longer one, the surnames agree, and at least two tokens are
 * shared.
 *
 * The last condition is what keeps it narrow. Without it, the roster's own fixtures collide:
 * "Proof Plain Member" and "Proof Admin Member" share a first and last token and are two records
 * on purpose -- neither token set contains the other, so this rule leaves them alone.
 */
function nameContains(left: string, right: string): boolean {
  const a = normalizePersonName(left).split(" ").filter(Boolean);
  const b = normalizePersonName(right).split(" ").filter(Boolean);
  if (a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-1)) {
    return false;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === longer.length) {
    return false;
  }
  const longerSet = new Set(longer);
  return shorter.every((token) => longerSet.has(token)) && shorter.length >= 2;
}

/** Every reason these two records look like one person. Empty means they do not. */
export function memberDuplicateReasons(
  left: DuplicateCandidate,
  right: DuplicateCandidate,
): MemberDuplicateReason[] {
  const reasons: MemberDuplicateReason[] = [];
  const leftEmails = new Set(emails(left));
  if (emails(right).some((value) => leftEmails.has(value))) {
    reasons.push("same_email");
  }
  const slack = left.slack_user_id?.trim();
  if (slack && slack === right.slack_user_id?.trim()) {
    reasons.push("same_slack_user_id");
  }
  const leftName = left.name?.trim() ?? "";
  const rightName = right.name?.trim() ?? "";
  if (leftName && rightName) {
    if (normalizePersonName(leftName) === normalizePersonName(rightName)) {
      reasons.push("same_name");
    } else if (isSamePerson(leftName, rightName) || nameContains(leftName, rightName)) {
      reasons.push("name_contains");
    }
  }
  return reasons;
}

/**
 * Every pair on the roster that looks like one person, most confident first.
 *
 * O(n²) over the member list, which is fine at the size a research lab actually is (~200) and is
 * why this is computed on read rather than stored: a duplicate is created by an import, and an
 * index that has to be rebuilt after every import is a second thing to forget.
 */
export function findDuplicateMembers<T extends DuplicateCandidate>(
  members: readonly T[],
): MemberDuplicatePair<T>[] {
  const pairs: MemberDuplicatePair<T>[] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const left = members[i] as T;
      const right = members[j] as T;
      const reasons = memberDuplicateReasons(left, right);
      if (reasons.length === 0) {
        continue;
      }
      const confidence =
        reasons.includes("same_email") || reasons.includes("same_slack_user_id")
          ? "high"
          : "likely";
      pairs.push({ left, right, reasons, confidence });
    }
  }
  return pairs.sort((a, b) =>
    a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1,
  );
}

/** A field the merge would have had to choose between, so the admin can see what it kept. */
export type MemberMergeConflict = {
  field: string;
  kept: unknown;
  discarded: unknown;
};

export type MemberMergePlan = {
  /** What to write onto the survivor. Only the keys the duplicate actually contributes. */
  patch: Record<string, unknown>;
  /** Fields both records answered differently. The survivor's answer is the one in `patch`. */
  conflicts: MemberMergeConflict[];
};

/**
 * Fields the merge must never carry across, whatever the duplicate holds.
 *
 * `id` is the record's identity and the thing every other table points at. `email` is the login
 * identity, and moving one onto a record that already has another would silently change who can
 * sign in as whom -- the service moves an orphaned *credential* instead, which is a decision with
 * an audit line on it. The timestamps describe the row, not the person.
 */
const NEVER_MERGED = new Set(["id", "email", "created_at", "updated_at"]);

/** Case-insensitive for plain values, structural for the object rows (access grants, trips). */
function dedupeKey(value: unknown): string {
  return typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value).trim().toLowerCase();
}

/** Both notes blocks, in survivor-then-duplicate order, with repeated lines dropped. */
function mergeNotes(current: string, incoming: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of [...current.split("\n"), ...incoming.split("\n")]) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(trimmed);
  }
  return lines.join("\n");
}

/**
 * Two records as one: the survivor's answers, plus everything only the duplicate knows.
 *
 * The rule is deliberately timid. A blank on the survivor is filled from the duplicate; a
 * disagreement is *kept as the survivor's* and reported as a conflict rather than resolved. An
 * admin picked which record survives, and quietly overwriting the half they chose with the half
 * they did not would make that choice meaningless.
 *
 * Lists are the one exception, and they union: research topics, projects and Slack channels are
 * sets of facts rather than single answers, and "which of these two lists is the real one" is not
 * a question either record can answer. Duplicates inside the union are dropped case-insensitively,
 * so "Robotics" and "robotics" do not both survive.
 */
export function planMemberMerge(
  survivor: Record<string, unknown>,
  duplicate: Record<string, unknown>,
): MemberMergePlan {
  const patch: Record<string, unknown> = {};
  const conflicts: MemberMergeConflict[] = [];
  for (const [field, incoming] of Object.entries(duplicate)) {
    if (NEVER_MERGED.has(field) || incoming === undefined || incoming === null || incoming === "") {
      continue;
    }
    const current = survivor[field];
    if (field === "notes") {
      // The one text field that is genuinely additive. The two ingestion paths each write a
      // provenance block -- "Source: Quick-Start Survey…" with the career detail behind it, and
      // "Created from the Slack member export." with the account facts -- and keeping only the
      // survivor's would throw away the half the merge exists to rescue. Line-deduped so a second
      // merge does not stack the same block twice.
      const merged = mergeNotes(typeof current === "string" ? current : "", String(incoming));
      if (merged !== current) {
        patch[field] = merged;
      }
      continue;
    }
    if (Array.isArray(incoming)) {
      const existing = Array.isArray(current) ? current : [];
      const seen = new Set(existing.map(dedupeKey));
      const added = incoming.filter((value) => {
        const key = dedupeKey(value);
        if (!key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      if (added.length > 0) {
        patch[field] = [...existing, ...added];
      }
      continue;
    }
    if (current === undefined || current === null || current === "") {
      patch[field] = incoming;
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(incoming)) {
      conflicts.push({ field, kept: current, discarded: incoming });
    }
  }
  return { patch, conflicts };
}
