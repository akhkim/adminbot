// Which papers this person has tucked away on My Projects & Papers.
//
// Per viewer and per browser, deliberately. Somebody with thirty papers cannot navigate the list,
// but a paper is shared: hiding it on the record would take it off a coauthor's page too, and the
// person who wanted a shorter list is rarely the person who wanted the paper gone. So this is a
// view preference, stored beside the other view preferences, and it changes nothing anyone else
// sees and nothing the service knows.
//
// Keyed by member id so two people sharing a browser do not inherit each other's hidden set, and
// so signing out and back in as somebody else does not present their list already pruned.
//
// Every read and write is wrapped: storage throws in a private window, in a thumbnail capture, and
// wherever site data is blocked, and a list that cannot be filtered has to render unfiltered
// rather than not at all.

import { getSafeLocalStorage } from "../../local-storage.ts";

const KEY_PREFIX = "adminbot:my-work:hidden-papers:v1";

function storageKey(memberId: string | null): string {
  return memberId ? `${KEY_PREFIX}:${memberId}` : KEY_PREFIX;
}

/** The ids this viewer has hidden. Empty whenever storage is unavailable or unreadable. */
export function readHiddenPapers(memberId: string | null): Set<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(storageKey(memberId));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

/** Replace the hidden set. Writing an empty set clears the key rather than storing "[]". */
export function writeHiddenPapers(memberId: string | null, ids: Set<string>): void {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    if (ids.size === 0) {
      storage.removeItem(storageKey(memberId));
      return;
    }
    storage.setItem(storageKey(memberId), JSON.stringify([...ids]));
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
}

/** Hide or unhide one paper, returning the new set so the caller can render from it. */
export function toggleHiddenPaper(memberId: string | null, paperId: string): Set<string> {
  const hidden = readHiddenPapers(memberId);
  if (hidden.has(paperId)) {
    hidden.delete(paperId);
  } else {
    hidden.add(paperId);
  }
  writeHiddenPapers(memberId, hidden);
  return hidden;
}

/** Bring everything back. */
export function clearHiddenPapers(memberId: string | null): void {
  writeHiddenPapers(memberId, new Set());
}

/**
 * Split a list into what to show and what is tucked away.
 *
 * Returns both halves rather than filtering in place, because the page has to be able to say how
 * many it is holding back. A list that silently drops rows is indistinguishable from a list that
 * lost them.
 */
export function partitionHiddenPapers<T extends { id: string }>(
  papers: readonly T[],
  hidden: ReadonlySet<string>,
): { visible: T[]; hidden: T[] } {
  const shown: T[] = [];
  const tucked: T[] = [];
  for (const paper of papers) {
    (hidden.has(paper.id) ? tucked : shown).push(paper);
  }
  return { visible: shown, hidden: tucked };
}
