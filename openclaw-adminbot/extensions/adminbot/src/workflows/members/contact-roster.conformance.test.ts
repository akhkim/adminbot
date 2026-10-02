// Is everybody on the lab's contact list actually in the database, with what the sheet says?
//
// The other half of the spreadsheet check. `contact-access-matrix.test.ts` asks whether the
// service's *policy* still matches the sheet; this asks whether the service's *data* does --
// whether all 153 contacts exist as roster rows, and whether the addresses and profile links on
// those rows are the ones the lab wrote down.
//
// Opt-in, because it needs a database and the repo does not ship one:
//
//   ADMINBOT_CONTACT_DB=~/adminbot-aurora.sqlite pnpm vitest run contact-roster.conformance
//
// Without that variable the suite skips rather than passing, so a green CI run never claims to
// have checked a roster it never opened.
//
// The database is copied to a temp file before it is opened. `AdminBotSqliteStore`'s constructor
// runs `CREATE TABLE IF NOT EXISTS` and sets WAL, so merely opening a store writes -- and a test
// that is routinely pointed at production must not be able to touch it. The copy also means a
// failure can be re-run against the same bytes.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminBotSqliteStore } from "../../persistence/sqlite.js";
import { normalizePersonName } from "../../contracts/person-names.js";
import { memberDuplicateReasons } from "../../contracts/member-duplicates.js";
import {
  adminBotExternalCollaboratorSubgroups,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import { CONTACT_MEMBERS } from "./generated/contact-roster.js";

const databasePath = process.env.ADMINBOT_CONTACT_DB?.trim();

/**
 * Compare a sheet value with a stored one without pretending they are the same string.
 *
 * The sheet keeps handles ("zhijing-jin") where the roster keeps URLs
 * ("https://github.com/zhijing-jin"), and both are the right answer to "what is their GitHub".
 * Comparing the last meaningful path segment is what makes those agree while still catching a
 * roster pointing at a different account.
 *
 * The leading `~` goes too. It is part of the canonical OpenReview id and the roster stores it,
 * but the sheet's column is filled in by hand and mostly omits it -- so keeping it would report
 * eighteen correct records as wrong, which is how a conformance test teaches people to ignore it.
 */
function handleOf(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return "";
  }
  const tail = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  return tail.replace(/^[@~]/u, "").toLowerCase();
}

/**
 * Whether a sheet cell is a handle at all.
 *
 * Some cells hold a hyperlink's display text rather than its target -- "Yara Allam | LinkedIn" is
 * what Excel shows for a linked cell, and it says nothing about which account the roster should
 * point at. Comparing against it produces a failure whose only fix is editing the spreadsheet to
 * please the test, so these are skipped instead.
 */
function isHandleLike(value: string): boolean {
  return value.trim() !== "" && !/[\s|]/u.test(value.trim());
}

function emailsOf(member: AdminBotLabMember): Set<string> {
  return new Set(
    [member.email, member.calendar_email, member.correspondence_email]
      .flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim().toLowerCase()] : [])),
  );
}

describe.skipIf(!databasePath)("contact list conformance", () => {
  // Opened in `beforeAll` rather than in the suite body: `describe.skipIf` still evaluates the
  // callback, so a body that copied the database would do it even on a skipped run -- and would
  // throw on the undefined path that made it skip in the first place.
  let workdir = "";
  let roster: AdminBotLabMember[] = [];
  const byKey = new Map<string, AdminBotLabMember>();

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "adminbot-contact-"));
    const copy = join(workdir, "roster.sqlite");
    copyFileSync(databasePath!, copy);
    roster = new AdminBotSqliteStore(copy).listLabMembers();
    for (const member of roster) {
      byKey.set(normalizePersonName(member.name), member);
    }
  });

  afterAll(() => {
    if (workdir) {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  /**
   * Roster rows that look like this contact under another spelling.
   *
   * Uses the lab's own rule -- the one behind the Lab Members duplicates panel -- rather than a
   * similarity threshold invented here. Reusing it means this test and that panel agree about
   * what "the same person" means, and it keeps the two failures below genuinely different jobs:
   * a contact with no match at all has to be created, and one that matches under another name has
   * to be renamed or merged. Reporting them as one list of 26 would hide that.
   */
  function nearMatches(contact: (typeof CONTACT_MEMBERS)[number]): AdminBotLabMember[] {
    const candidate = {
      // `memberDuplicateReasons` compares names, emails and Slack ids, never ids -- but the type
      // requires one, and the folded key is the only stable handle a sheet row has. It carries
      // spaces, so it cannot collide with a roster slug even if some future rule does read it.
      id: contact.key,
      name: contact.name,
      ...(contact.fields.correspondence_email
        ? { correspondence_email: contact.fields.correspondence_email }
        : {}),
    };
    return roster.filter((member) => memberDuplicateReasons(candidate, member).length > 0);
  }

  it("has a roster row for every contact on the sheet", () => {
    const absent = CONTACT_MEMBERS.filter(
      (contact) => !byKey.has(contact.key) && nearMatches(contact).length === 0,
    ).map((contact) => `${contact.name} (${contact.sources.join(" + ")})`);
    expect(
      absent,
      `${absent.length} of ${CONTACT_MEMBERS.length} contacts have no roster row at all`,
    ).toEqual([]);
  });

  it("spells every contact the way the sheet does", () => {
    const renamed = CONTACT_MEMBERS.filter((contact) => !byKey.has(contact.key))
      .flatMap((contact) => {
        const near = nearMatches(contact);
        return near.length ? [`${contact.name} -> ${near.map((m) => `${m.name} [${m.id}]`).join(", ")}`] : [];
      });
    // A separate failure from the one above because the fix is different: these people are on the
    // roster, under a name the sheet does not use. Left alone, every join between the two -- this
    // test, an import, a paper's author list -- reads them as two people.
    expect(renamed, `${renamed.length} contacts are on the roster under another name`).toEqual([]);
  });

  it("holds every address the sheet has for them", () => {
    const wrong: string[] = [];
    for (const contact of CONTACT_MEMBERS) {
      const member = byKey.get(contact.key);
      if (!member) {
        continue; // Reported by the presence test; not worth failing twice.
      }
      const stored = emailsOf(member);
      for (const field of ["correspondence_email", "calendar_email"] as const) {
        const expected = contact.fields[field]?.trim().toLowerCase();
        if (expected && !stored.has(expected)) {
          wrong.push(`${contact.name}: sheet ${field} ${expected} is on no field of ${member.id}`);
        }
      }
    }
    expect(wrong, `${wrong.length} contacts are missing an address the sheet has`).toEqual([]);
  });

  it("points at the same profiles the sheet does", () => {
    const wrong: string[] = [];
    const links = [
      ["github", "github_url"],
      ["linkedin", "linkedin_url"],
      ["openreview", "openreview_id"],
    ] as const;
    for (const contact of CONTACT_MEMBERS) {
      const member = byKey.get(contact.key);
      if (!member) {
        continue;
      }
      for (const [sheetField, memberField] of links) {
        const raw = contact.fields[sheetField] ?? "";
        if (!isHandleLike(raw)) {
          continue;
        }
        const expected = handleOf(raw);
        const stored = handleOf(String(member[memberField] ?? ""));
        // Only a *disagreement* fails. A blank on the roster where the sheet has a value is the
        // ordinary state of a record nobody has filled in yet, and is what the profile sweep
        // already chases; a roster pointing at a different account is a wrong answer.
        if (expected && stored && expected !== stored) {
          wrong.push(`${contact.name}: ${memberField} is ${stored}, sheet says ${expected}`);
        }
      }
    }
    expect(wrong, `${wrong.length} contacts have a profile link that disagrees`).toEqual([]);
  });

  it("only uses collaborator subgroups the contract defines", () => {
    const vocabulary = new Set<string>(adminBotExternalCollaboratorSubgroups);
    const wrong = roster
      .filter((member) => member.collaborator_subgroup !== undefined)
      .filter((member) => !vocabulary.has(member.collaborator_subgroup as string))
      .map((member) => `${member.id}: ${String(member.collaborator_subgroup)}`);
    expect(wrong).toEqual([]);
  });

  it("gives every external collaborator a subgroup to be governed by", () => {
    // The access matrix is keyed entirely on the subgroup, so an external collaborator without
    // one is a person no row of the policy applies to -- they are neither granted nor denied.
    const ungoverned = roster
      .filter((member) => member.privilege_level === "external_collaborator")
      .filter((member) => !member.collaborator_subgroup)
      .map((member) => `${member.id} (${member.name})`);
    expect(ungoverned, `${ungoverned.length} external collaborators have no subgroup`).toEqual([]);
  });
});
