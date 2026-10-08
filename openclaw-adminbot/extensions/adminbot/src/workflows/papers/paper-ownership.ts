import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import { authorMemberIds } from "./author-links.js";

/** How the ownership check folds a roster name before comparing it with a paper's authors. */
function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * How many roster members carry each folded name. A name match only counts when the name is
 * unique on the whole roster, so the count is read from the full roster, never a filtered one.
 */
export function rosterNameCounts(roster: readonly AdminBotLabMember[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const member of roster) {
    const key = nameKey(member.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether `member` is on `paper`: the recorded ids first, then the member's id or email written as
 * an author, and last their name -- but only when no one else on the roster shares it.
 */
export function memberOwnsPaper(
  member: AdminBotLabMember,
  paper: AdminBotPaperRecord,
  /** Roster members carrying a folded name; only asked once every cheaper check has failed. */
  nameCount: (name: string) => number,
): boolean {
  if (paper.submitted_by_member_id === member.id) {
    return true;
  }
  if (paper.first_author_member_id === member.id) {
    return true;
  }
  if (authorMemberIds(paper.author_links ?? []).includes(member.id)) {
    return true;
  }
  const authors = paper.authors.map(nameKey);
  const unique = [member.id, member.email]
    .flatMap((value) => (value ? [value.toLocaleLowerCase()] : []))
    .some((value) => authors.includes(value));
  if (unique) {
    return true;
  }
  const name = nameKey(member.name);
  if (!name || !authors.includes(name)) {
    return false;
  }
  return nameCount(name) === 1;
}

/**
 * The ids of the papers each of `members` owns, in `papers` order -- the same answer as filtering
 * `papers` with memberOwnsPaper once per member, in one pass over the papers instead of
 * members x papers checks.
 */
export function paperIdsByOwner(
  members: readonly AdminBotLabMember[],
  papers: readonly AdminBotPaperRecord[],
  nameCounts: ReadonlyMap<string, number>,
): Map<string, string[]> {
  const owned = new Map<string, string[]>();
  // Author spellings that resolve to a member: their id, their email, their unique name.
  const byAuthorKey = new Map<string, string[]>();
  const addKey = (key: string, memberId: string) => {
    const ids = byAuthorKey.get(key);
    if (ids) {
      ids.push(memberId);
    } else {
      byAuthorKey.set(key, [memberId]);
    }
  };
  for (const member of members) {
    owned.set(member.id, []);
    for (const value of [member.id, member.email]) {
      if (value) {
        addKey(value.toLocaleLowerCase(), member.id);
      }
    }
    const name = nameKey(member.name);
    if (name && nameCounts.get(name) === 1) {
      addKey(name, member.id);
    }
  }
  for (const paper of papers) {
    const owners = new Set<string>();
    for (const id of [
      paper.submitted_by_member_id,
      paper.first_author_member_id,
      ...authorMemberIds(paper.author_links ?? []),
    ]) {
      if (id && owned.has(id)) {
        owners.add(id);
      }
    }
    for (const author of paper.authors) {
      for (const id of byAuthorKey.get(nameKey(author)) ?? []) {
        owners.add(id);
      }
    }
    for (const id of owners) {
      owned.get(id)?.push(paper.id);
    }
  }
  return owned;
}
