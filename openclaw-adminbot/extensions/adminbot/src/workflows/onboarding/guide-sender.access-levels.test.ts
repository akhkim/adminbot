// What an onboarding send actually *does*, for every access level.
//
// The rest of the onboarding suite checks pieces: which template a member type routes to, which
// address the copy names, how a Drive folder is built. Nothing checked the send itself against the
// access matrix -- so "this subgroup is owed the two active channels" was a row in a table that
// only a real onboarding could prove. That is the expensive kind of gap: these paths run in front
// of a new member, once, and a break is discovered by them.
//
// NOTHING HERE REACHES THE OUTSIDE WORLD. Every effect that leaves the process is injected as a
// recorder, and `sendEmail` is injected on every single call -- it is the one option with a real
// fallback (`gogEmailSender`, which shells out to `gog`), so omitting it is the only way this file
// could ever deliver mail. `send()` below is the only way these tests construct a sender, which is
// what keeps that true as tests are added.

import { describe, expect, it } from "vitest";
import {
  adminBotExternalCollaboratorSubgroups,
  type AdminBotExternalCollaboratorSubgroup,
} from "../../contracts/actions.js";
import { collaboratorSubgroupAccess } from "../members/collaborator-subgroups.js";
import { createDcsRosterSheetRecorder, DCS_ROSTER_SHEET_COLUMNS } from "./dcs-roster-sheet.js";
import { findOnboardingTemplate } from "./emails.js";
import {
  ADMINBOT_ACTIVE_CHANNELS_ENV,
  createAdminBotOnboardingSender,
  type AdminBotOnboardingSendResult,
} from "./guide-sender.js";

/**
 * The two placeholders that are *provisioned* rather than typed.
 *
 * Deliberately never auto-filled: the sender only provisions when the copy names the placeholder
 * **and** no value was supplied, so filling these in would switch off the very behaviour this file
 * exists to check.
 */
const PROVISIONED_PLACEHOLDERS = new Set(["drive_folder_link", "slack_connect_link"]);

/** Every value this template demands of the operator, filled with something plausible. */
function formValuesFor(templateId: string): Record<string, string> {
  const template = findOnboardingTemplate(templateId);
  const values: Record<string, string> = {};
  for (const field of template?.required ?? []) {
    if (PROVISIONED_PLACEHOLDERS.has(field)) {
      continue;
    }
    values[field] = `test-${field}`;
  }
  return values;
}

type Recorded = {
  mail: Array<{ to: string; subject: string }>;
  drive: string[];
  connect: Array<{ email: string; channelId: string }>;
  /** Rows appended to the DCS roster sheet, which is the half that reaches the university. */
  dcsRows: string[][];
};

/**
 * One send, with every outward effect replaced by a recorder.
 *
 * The env is built here rather than read from the process: `resolveActiveChannels` reads it, and a
 * test that inherited the host's would pass or fail depending on whose machine it ran on.
 */
async function send(
  templateId: string,
  options: { activeChannels?: string | undefined; name?: string } = {},
): Promise<{
  result: Awaited<ReturnType<ReturnType<typeof createAdminBotOnboardingSender>>>;
  recorded: Recorded;
}> {
  const recorded: Recorded = { mail: [], drive: [], connect: [], dcsRows: [] };
  const sender = createAdminBotOnboardingSender({
    // Built here, never inherited: `resolveActiveChannels` and the deployment tokens read the
    // environment, and a test that took the host's would pass or fail depending on whose machine
    // it ran on.
    env: {
      ADMINBOT_SLACK_INVITE_URL: "https://join.slack.com/t/jinesis/shared_invite/test",
      ADMINBOT_CONTACT_EMAILS: "akim@cs.toronto.edu",
      ADMINBOT_BOT_EMAIL: "adminbot@example.test",
      ...(options.activeChannels === undefined
        ? {}
        : { [ADMINBOT_ACTIVE_CHANNELS_ENV]: options.activeChannels }),
    } as NodeJS.ProcessEnv,
    provisionDriveWorkspace: async () => {
      recorded.drive.push(templateId);
      return { folderId: "folder-1", link: "https://drive.google.com/drive/folders/folder-1" };
    },
    inviteToSlackConnect: async ({ email, channelId }) => {
      recorded.connect.push({ email, channelId });
      return { url: "https://join.slack.com/share/TEST" };
    },
    // The real recorder over a fake sheet, rather than a stub of it. What goes in the row is the
    // one thing here that cannot be quietly wrong, and the rules that decide it -- the username
    // candidates and the mononym refusal -- live inside the recorder, so a stub would assert
    // against nothing. The sheet starts as a bare header row, so every candidate is free.
    addDcsRosterRow: createDcsRosterSheetRecorder({
      spreadsheetId: "sheet-1",
      readRows: async () => [[...DCS_ROSTER_SHEET_COLUMNS]],
      appendRows: async (_spreadsheetId, rows) => {
        recorded.dcsRows.push(...rows);
      },
      generatePassword: () => "TEST-TEMP-PASSWORD",
      now: () => new Date("2026-09-20T00:00:00Z"),
    }),
    headProfessorWhatsapp: () => "+1 555 0100",
    // Always injected. See the file header: this is the only option with a real-world fallback.
    sendEmail: async ({ to, subject }) => {
      recorded.mail.push({ to, subject });
    },
  });
  const result = await sender({
    template_id: templateId,
    name: options.name ?? "Ada Lovelace",
    email: "ada@example.test",
    slack_channel_id: "C0TEST",
    // Read off the template rather than hardcoded, so this file does not have to be edited every
    // time a template gains a field -- a missing value is a 400 about the operator's form, which is
    // guide.test.ts's subject and would only mask the provisioning question being asked here.
    values: formValuesFor(templateId),
  });
  return { result, recorded };
}

const payloadOf = (result: Awaited<ReturnType<typeof send>>["result"]) => {
  if (!result.ok) {
    throw new Error(`send refused: ${result.error.message}`);
  }
  return result.payload as AdminBotOnboardingSendResult;
};

/** The subgroups whose template id is also an onboarding template -- see guide-sender's own lookup. */
const WITH_TEMPLATE = adminBotExternalCollaboratorSubgroups.filter((subgroup) =>
  Boolean(findOnboardingTemplate(subgroup)),
);

const grants = (subgroup: AdminBotExternalCollaboratorSubgroup) =>
  new Set(collaboratorSubgroupAccess(subgroup).map((grant) => grant.item));

describe("onboarding sends nothing to the outside world under test", () => {
  it("records the mail instead of delivering it", async () => {
    const { result, recorded } = await send("coauthor_major");
    expect(payloadOf(result).sent).toBe(true);
    expect(recorded.mail).toEqual([{ to: "ada@example.test", subject: expect.any(String) }]);
  });
});

describe("the access matrix decides the standing-channel invites", () => {
  /**
   * Who is put in #jinesis-active and #random-active by an onboarding send.
   *
   * Written out rather than read from `collaboratorSubgroupAccess`. Deriving it there would be
   * circular -- the sender reads the same table, so both sides would move together and the test
   * could never fail. (It was written that way first, and removing a subgroup from the matrix
   * passed.) A literal list means a matrix edit has to come past this file, which is the point:
   * these two channels are the lab's own space, and who lands in them is a decision, not a detail.
   */
  const OWED_ACTIVE_CHANNELS = ["own_pace_advisee", "coauthor_major"];

  it("matches the access matrix, and fails if either side moves alone", () => {
    const fromMatrix = WITH_TEMPLATE.filter((subgroup) => grants(subgroup).has("active_channels"));
    expect(fromMatrix.toSorted()).toEqual(OWED_ACTIVE_CHANNELS.toSorted());
  });

  // The one provisioning effect the matrix actually drives. `active_channels` was made
  // matrix-driven on purpose -- the Drive folder taught the lab what a copy-driven trigger costs --
  // so this is the row where "the table says so" and "the send does it" can be checked against
  // each other, per subgroup, without a real onboarding.
  it.each(WITH_TEMPLATE)("invites %s to exactly what the matrix grants them", async (subgroup) => {
    const owed = OWED_ACTIVE_CHANNELS.includes(subgroup);
    const { result } = await send(subgroup, { activeChannels: "C-JINESIS,C-RANDOM" });
    const invites = payloadOf(result).active_channel_invites;
    if (!owed) {
      expect(invites).toBeUndefined();
      return;
    }
    expect(invites?.configured).toBe(true);
    expect(invites?.invited.map((entry) => entry.channel)).toEqual(["C-JINESIS", "C-RANDOM"]);
  });

  it("reports an unconfigured deployment rather than silently inviting nobody", async () => {
    // A deployment that never set the variable must still be able to onboard these subgroups --
    // an uninvited member is a worse failure than a refused send -- but the operator has to see it.
    const { result } = await send(OWED_ACTIVE_CHANNELS[0]!, { activeChannels: undefined });
    expect(payloadOf(result).active_channel_invites).toEqual({ configured: false, invited: [] });
  });
});

describe("what each access level's send provisions", () => {
  /**
   * Drive and Slack Connect are triggered by the placeholders in the copy, not by the matrix.
   *
   * That is deliberate -- see the note on the `coauthor_major` template in emails.ts -- but it
   * means the matrix rows `project_drive_folder` and `slack_connect_friends_channel` are
   * descriptions rather than instructions, and the two disagree today. This table is what the send
   * actually does, so a change to either the copy or the matrix has to come past it.
   */
  const PROVISIONS: Record<string, { drive: boolean; connect: boolean }> = {
    interviewee: { drive: true, connect: true },
    slightly_better_than_emails: { drive: false, connect: true },
    alumni: { drive: false, connect: false },
    own_pace_advisee: { drive: false, connect: false },
    coauthor_minor: { drive: false, connect: false },
    coauthor_major: { drive: false, connect: false },
    disappearing_coauthor: { drive: false, connect: false },
  };

  it.each(WITH_TEMPLATE)("provisions for %s what its copy asks for", async (subgroup) => {
    const expected = PROVISIONS[subgroup];
    expect(expected, `${subgroup} is missing from PROVISIONS`).toBeDefined();
    const { result, recorded } = await send(subgroup, { activeChannels: "C-JINESIS,C-RANDOM" });
    const payload = payloadOf(result);
    expect(Boolean(payload.drive_folder_link)).toBe(expected!.drive);
    expect(recorded.drive.length > 0).toBe(expected!.drive);
    expect(Boolean(payload.slack_connect_link)).toBe(expected!.connect);

    // The friends-channel invite and the standing-channel invites are minted through the same
    // `inviteToSlackConnect` dep, so the raw call count conflates them. Every call has to be
    // explained by one or the other -- an unexplained one would be an invite nobody asked for.
    const expectedCalls =
      (expected!.connect ? 1 : 0) + (payload.active_channel_invites?.invited.length ?? 0);
    expect(recorded.connect).toHaveLength(expectedCalls);
  });

  it("mints a Slack Connect invite for alumni through the delayed template, not the welcome", async () => {
    // The alumni row is granted the friends-and-collaborators channel by the matrix and its welcome
    // provisions nothing -- because the invitation is a separate mail ten days later. Checked here
    // so the welcome's silence reads as the design rather than as a missing invite.
    const { recorded } = await send("alumni_slack_connect");
    expect(recorded.connect).toHaveLength(1);
  });
});

describe("access levels with no onboarding mail at all", () => {
  it("names them, so adding one is a decision rather than an oversight", () => {
    const without = adminBotExternalCollaboratorSubgroups.filter(
      (subgroup) => !findOnboardingTemplate(subgroup),
    );
    // These three are reachable only by hand today. Two of them -- coauthor_discussant_designer and
    // external_prof -- are granted a Slack Connect invite by the matrix and have no send that mints
    // one, which is the gap this list exists to keep visible.
    expect(without.toSorted()).toEqual(
      ["acquaintance", "coauthor_discussant_designer", "external_prof"].toSorted(),
    );
  });
});

// The row is acted on by the university's sysadmin under the lab's name, so what goes in it is
// the one thing here that cannot be quietly wrong.
describe("the DCS roster row", () => {
  const DCS_TEMPLATE = "member";
  const column = (row: string[], name: (typeof DCS_ROSTER_SHEET_COLUMNS)[number]) =>
    row[DCS_ROSTER_SHEET_COLUMNS.indexOf(name)];

  it("files the preferred username built from the roster's one free-text name", async () => {
    const { recorded } = await send(DCS_TEMPLATE, { name: "Eric Zhang" });
    expect(recorded.dcsRows).toHaveLength(1);
    const row = recorded.dcsRows[0] as string[];
    expect(column(row, "full_name")).toBe("Eric Zhang");
    expect(column(row, "dcs_username")).toBe("eric");
    expect(column(row, "dcs_password")).toBe("TEST-TEMP-PASSWORD");
    expect(column(row, "date_of_this_row_change")).toBe("2026-09-20");
  });

  // A brand-new account gets the least-privileged value in the DCS vocabulary. An escalation is a
  // deliberate later row, never a side effect of onboarding.
  it("asks for the least-privileged access when the roster grants nothing yet", async () => {
    const { recorded } = await send(DCS_TEMPLATE, { name: "Eric Zhang" });
    expect(column(recorded.dcsRows[0] as string[], "permission")).toBe("UofT-slack-only");
  });

  // The bug this inherited from the retired form: a one-word name once filed a real account for
  // "Eric Eric". Two of the three username rules are built from the last name, so the refusal
  // travelled with them.
  it("refuses to file rather than inventing a username from a mononym", async () => {
    const { result, recorded } = await send(DCS_TEMPLATE, { name: "Eric" });
    expect(recorded.dcsRows).toEqual([]);
    const row = payloadOf(result).dcs_roster_row;
    expect(row?.added).toBe(false);
    expect(row?.error).toContain("first and a last name");
  });

  // The guide is the thing the member is waiting for; the row is a side errand. A name the rules
  // cannot take must not hold up the mail.
  it("still sends the guide when the row cannot be filed", async () => {
    const { result, recorded } = await send(DCS_TEMPLATE, { name: "Eric" });
    expect(payloadOf(result).sent).toBe(true);
    expect(recorded.mail).toHaveLength(1);
  });
});
