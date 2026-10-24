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
import { isSamePerson, normalizePersonName, toFirstLast } from "./person-names.js";

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

type NameIndex = {
  minLength: number;
  byLength: Map<number, number[]>;
  children: Map<string, NameIndex>;
};

function nameIndex(): NameIndex {
  return { minLength: Infinity, byLength: new Map(), children: new Map() };
}

/** Every pair on the roster that looks like one person, most confident first. */
export function findDuplicateMembers<T extends DuplicateCandidate>(
  members: readonly T[],
): MemberDuplicatePair<T>[] {
  // Only pairs sharing an account fact or a possible name shape need the exact rules below.
  // ponytail: Returning every pair is quadratic when most names collide; page candidates in the
  // service if a real roster reaches that ceiling.
  const candidates = new Map<number, Set<number>>();
  const addPair = (a: number, b: number) => {
    if (a === b) {
      return;
    }
    const [left, right] = a < b ? [a, b] : [b, a];
    const row = candidates.get(left) ?? new Set<number>();
    row.add(right);
    candidates.set(left, row);
  };
  const addTo = (index: Map<string, number[]>, key: string, position: number) => {
    const bucket = index.get(key) ?? [];
    bucket.push(position);
    index.set(key, bucket);
  };
  const addPrior = (index: Map<string, number[]>, key: string, position: number) => {
    for (const previous of index.get(key) ?? []) {
      addPair(previous, position);
    }
    addTo(index, key, position);
  };
  const byEmail = new Map<string, number[]>();
  const bySlack = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const byAuthorName = new Map<string, number[]>();
  const byAuthorEnds = new Map<string, number[]>();
  const byPlainAuthorEnds = new Map<string, number[]>();
  const names: Array<{ tokens: string[]; surname: string }> = [];
  const containingNames = new Map<string, NameIndex>();

  for (let i = 0; i < members.length; i += 1) {
    const member = members[i] as T;
    for (const email of new Set(emails(member))) {
      addPrior(byEmail, email, i);
    }
    const slack = member.slack_user_id?.trim();
    if (slack) {
      addPrior(bySlack, slack, i);
    }
    const name = member.name?.trim() ?? "";
    const raw = normalizePersonName(name);
    const tokens = raw.split(" ").filter(Boolean);
    const surname = tokens.at(-1) ?? "";
    names.push({ tokens, surname });
    if (!name) {
      continue;
    }
    addPrior(byName, raw, i);

    // isSamePerson normalizes its first argument as an author ("Last, First" is reversed),
    // but its second as a roster name. Preserve that directional rule by indexing earlier rows
    // in the first-argument shape and looking up this row in the second-argument shape.
    if (raw) {
      for (const previous of byAuthorName.get(raw) ?? []) {
        addPair(previous, i);
      }
    }
    if (tokens.length >= 2) {
      const ends = `${tokens[0]}\0${surname}`;
      const index = tokens.length === 2 ? byAuthorEnds : byPlainAuthorEnds;
      for (const previous of index.get(ends) ?? []) {
        addPair(previous, i);
      }
    }
    const author = normalizePersonName(toFirstLast(name));
    if (author) {
      addTo(byAuthorName, author, i);
      const authorTokens = author.split(" ");
      if (authorTokens.length >= 2) {
        const ends = `${authorTokens[0]}\0${authorTokens.at(-1)}`;
        addTo(byAuthorEnds, ends, i);
        if (authorTokens.length === 2) {
          addTo(byPlainAuthorEnds, ends, i);
        }
      }
    }
    if (tokens.length >= 2) {
      let node = containingNames.get(surname);
      if (!node) {
        node = nameIndex();
        containingNames.set(surname, node);
      }
      const otherTokens = [...new Set(tokens.filter((token) => token !== surname))].toSorted();
      for (const token of otherTokens) {
        node.minLength = Math.min(node.minLength, tokens.length);
        let child = node.children.get(token);
        if (!child) {
          child = nameIndex();
          node.children.set(token, child);
        }
        node = child;
      }
      node.minLength = Math.min(node.minLength, tokens.length);
      const bucket = node.byLength.get(tokens.length) ?? [];
      bucket.push(i);
      node.byLength.set(tokens.length, bucket);
    }
  }

  // nameContains is symmetric: a shorter token set must be contained in a longer one, with the
  // same surname. The trie visits only token subsets that occur in the roster, not every pair of
  // people who happens to share a common surname.
  for (let i = 0; i < names.length; i += 1) {
    const { tokens, surname } = names[i] as { tokens: string[]; surname: string };
    if (tokens.length < 3) {
      continue;
    }
    const root = containingNames.get(surname);
    if (!root || root.minLength >= tokens.length) {
      continue;
    }
    const otherTokens = [...new Set(tokens.filter((token) => token !== surname))].toSorted();
    const visit = (node: NameIndex, start: number) => {
      if (node.minLength >= tokens.length) {
        return;
      }
      for (let length = 2; length < tokens.length; length += 1) {
        for (const shorter of node.byLength.get(length) ?? []) {
          addPair(i, shorter);
        }
      }
      for (let at = start; at < otherTokens.length; at += 1) {
        const child = node.children.get(otherTokens[at] as string);
        if (child) {
          visit(child, at + 1);
        }
      }
    };
    visit(root, 0);
  }

  const high: MemberDuplicatePair<T>[] = [];
  const likely: MemberDuplicatePair<T>[] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (const j of [...(candidates.get(i) ?? [])].toSorted((a, b) => a - b)) {
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
      (confidence === "high" ? high : likely).push({ left, right, reasons, confidence });
    }
  }
  return [...high, ...likely];
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
