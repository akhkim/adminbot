// Who is actually on a paper, and whose page it therefore appears on.
//
// A paper belongs to everyone who wrote it, not to whoever happened to file it. That was already
// the intent -- `memberOwnsPaper` tried to honour it by matching the printed author list against
// roster names -- but the match is guesswork over strings the venue owns: "Joeun Yook*" for equal
// contribution, "Yook, Joeun" from a BibTeX paste, "Schölkopf" against a roster that says
// "Scholkopf", two people who share a surname. Every miss made a paper invisible to a coauthor on
// their own work, and every miss was silent.
//
// So the link is recorded when somebody picks the author, and inferred only as a fallback for the
// rows that predate the picker. Pure: this file turns names and a roster into links, and the
// service decides what to store.
import type { AdminBotLabMember, AdminBotPaperAuthorLink } from "../../contracts/actions.js";
import { isSamePerson, normalizePersonName } from "../../contracts/person-names.js";

/** The roster shape this file needs. Anything with an id, a name and maybe an address. */
type RosterMember = Pick<AdminBotLabMember, "id" | "name"> & { email?: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isEmailLike(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}

/**
 * Resolve one printed name to a roster member, or to nobody.
 *
 * Unambiguous matches only, and in a deliberate order: an exact id or address is a fact, a name is
 * an opinion. A name shared by two roster rows resolves to neither -- being asked to pick is a
 * better outcome than silently putting a paper on the wrong person's page, which is exactly what
 * the old surname match did.
 */
export function resolveAuthorMember(
  name: string,
  roster: readonly RosterMember[],
): RosterMember | undefined {
  const raw = name.trim();
  if (!raw) {
    return undefined;
  }
  const lowered = raw.toLocaleLowerCase();
  const byIdentity = roster.find(
    (member) =>
      member.id.toLocaleLowerCase() === lowered ||
      (member.email ?? "").toLocaleLowerCase() === lowered,
  );
  if (byIdentity) {
    return byIdentity;
  }
  const named = roster.filter((member) => isSamePerson(raw, member.name));
  return named.length === 1 ? named[0] : undefined;
}

/**
 * One author entry, cleaned up.
 *
 * A link never carries both a member id and an email: a member's address lives on their roster
 * row, and a second copy here would be a second thing to keep in step. An email that turns out to
 * belong to a roster member is promoted to that member rather than kept as an external -- somebody
 * typing a colleague's address means the colleague, not a stranger who happens to share it.
 */
function normalizeLink(
  link: AdminBotPaperAuthorLink,
  roster: readonly RosterMember[],
): AdminBotPaperAuthorLink | undefined {
  const name = link.name.trim();
  const email = link.email?.trim().toLocaleLowerCase();
  const memberId = link.member_id?.trim();
  const member =
    (memberId ? roster.find((entry) => entry.id === memberId) : undefined) ??
    (email ? roster.find((entry) => (entry.email ?? "").toLocaleLowerCase() === email) : undefined);
  if (member) {
    return { name: name || member.name, member_id: member.id };
  }
  if (email && isEmailLike(email)) {
    // An external with no name of their own is listed by address: better a row that says
    // who to ask than a blank the card cannot render.
    return { name: name || email, email };
  }
  return name ? { name } : undefined;
}

/**
 * The author list as links, in print order, with nothing duplicated.
 *
 * `links` is what the picker recorded; `names` is the printed list a legacy caller sent instead.
 * When both arrive the links win and the names are ignored -- they are the same list, and the one
 * carrying identities is the one worth keeping.
 *
 * Unlinked names are resolved against the roster on the way through. That is what quietly repairs
 * every paper filed before the picker existed: the first save after this ships links whoever the
 * roster can name, and the paper appears on their page from then on.
 */
export function buildAuthorLinks(params: {
  links?: readonly AdminBotPaperAuthorLink[];
  names?: readonly string[];
  roster: readonly RosterMember[];
}): AdminBotPaperAuthorLink[] {
  const source: AdminBotPaperAuthorLink[] = params.links?.length
    ? params.links.map((link) => ({ ...link }))
    : (params.names ?? []).map((name) => ({ name }));

  const out: AdminBotPaperAuthorLink[] = [];
  const seenMembers = new Set<string>();
  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();

  for (const entry of source) {
    let link = normalizeLink(entry, params.roster);
    if (!link) {
      continue;
    }
    if (!link.member_id && !link.email) {
      // The fallback that repairs the old rows. An address typed straight into the name column is
      // read as an address, because that is plainly what somebody meant by it.
      if (isEmailLike(link.name)) {
        link = normalizeLink({ name: link.name, email: link.name }, params.roster) ?? link;
      } else {
        const member = resolveAuthorMember(link.name, params.roster);
        if (member) {
          link = { name: link.name, member_id: member.id };
        }
      }
    }
    const memberKey = link.member_id;
    const emailKey = link.email;
    const nameKey = normalizePersonName(link.name);
    if (memberKey) {
      if (seenMembers.has(memberKey)) {
        continue;
      }
      seenMembers.add(memberKey);
    } else if (emailKey) {
      if (seenEmails.has(emailKey)) {
        continue;
      }
      seenEmails.add(emailKey);
    } else {
      if (nameKey && seenNames.has(nameKey)) {
        continue;
      }
      if (nameKey) {
        seenNames.add(nameKey);
      }
    }
    out.push(link);
  }
  return out;
}

/** The printed list, regenerated from the links so the two cannot drift. */
export function authorNamesFromLinks(links: readonly AdminBotPaperAuthorLink[]): string[] {
  return links.map((link) => link.name);
}

/** Roster ids on this paper, in print order. The set whose pages it appears on. */
export function authorMemberIds(links: readonly AdminBotPaperAuthorLink[]): string[] {
  return links.map((link) => link.member_id).filter((id): id is string => Boolean(id));
}

/** Everyone on the paper who is not on the roster, for the card's external list. */
export function externalAuthors(
  links: readonly AdminBotPaperAuthorLink[],
): Array<{ name: string; email: string }> {
  return links
    .filter((link): link is AdminBotPaperAuthorLink & { email: string } => Boolean(link.email))
    .map((link) => ({ name: link.name, email: link.email }));
}
