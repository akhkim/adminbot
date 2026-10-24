// The DCS roster row, written whenever somebody becomes a full member or a major coauthor: on a
// Lab Members tab save, on Add member, on approving a sweep joiner, and when the nightly roster
// sync applies a type changed in the spreadsheet. The sheet is a derivative of the roster, so every
// row is written directly: a typed `dcs_roster.add_row` proposal that its policy auto-approves,
// executed on the spot and laid out against the live header when it runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotLabMemberInput, AdminBotStoredProposal } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import type { AdminBotOnboardingSender } from "../workflows/onboarding/guide-sender.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const MEMBER_SHEET_HEADER = [
  "Name",
  "Member Type",
  "Email for correspondence (the more professional the better)",
  "Slack email",
];
// The live DCS sheet's header as of 2026-10-20: no `dcs_password`, and `UTORid` before the date.
const DCS_HEADER = [
  "full_name",
  "adminbot_internal_id",
  "dcs_username",
  "non_dcs_email",
  "career_stage",
  "at_uoft_or_not",
  "permission",
  "UTORid",
  "date_of_this_row_change",
];
// Somebody already holding `minnie`, so the filing has to take the next candidate.
const HOLDS_MINNIE = ["Mina Other", "mina-other", "minnie", "", "full", "", "UofT-slack-only"];

const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

type StartOptions = {
  /** Rows on the DCS sheet below its header. Absent: no DCS sheet configured at all. */
  dcsRows?: string[][];
  memberSheetRows?: string[][];
};

async function startService(options: StartOptions = {}) {
  const appended: string[][] = [];
  const dcsRows = options.dcsRows;
  const dcsRosterSheet = dcsRows
    ? {
        spreadsheetId: "dcs-sheet",
        read: vi.fn(async () => [DCS_HEADER, ...dcsRows, ...appended]),
        append: vi.fn(async (_spreadsheetId: string, rows: string[][]) => {
          appended.push(...rows);
        }),
      }
    : undefined;
  const onboardingSender = (async () => ({
    ok: true,
    payload: { template_id: "member", subject: "Hi", body: "Hi" },
  })) as unknown as AdminBotOnboardingSender;
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    inviteToSlackConnect: async ({ email }) => ({ url: `https://join.slack.example/${email}` }),
    // Every other step's connector: recorded and claimed, so nothing reaches the outside world.
    executor: { execute: async () => ({ handled: true }) },
    onboardingSender,
    memberSheet: {
      spreadsheetId: "member-sheet",
      tab: "Roster",
      read: vi.fn(async () => [MEMBER_SHEET_HEADER, ...(options.memberSheetRows ?? [])]),
    },
    ...(dcsRosterSheet ? { dcsRosterSheet } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push(mock);
  for (const seed of [
    {
      id: "admin",
      name: "Admin",
      email: "admin@cs.toronto.edu",
      privilege_level: "admin",
      member_type: "full",
    },
    {
      id: "minnie",
      name: "Minnie Minor",
      email: "minnie@lab.test",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_minor",
      member_type: "coauthor-minor",
    },
    {
      id: "cora",
      name: "Cora Coauthor",
      email: "cora@lab.test",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
      member_type: "coauthor-major",
    },
    {
      id: "fern",
      name: "Fern Fullmember",
      email: "fern@lab.test",
      privilege_level: "member",
      member_type: "full",
    },
  ] as AdminBotLabMemberInput[]) {
    const saved = mock.service.upsertLabMember(withCompleteProfile(seed));
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock, appended, dcsRosterSheet };
}

async function adminToken(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
): Promise<string> {
  const headers = { "Content-Type": "application/json" };
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      member_id: "admin",
      email: "admin@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const registration = (
    (await pending.json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === "admin");
  if (!registration) {
    throw new Error("no pending registration for admin");
  }
  const approved = await mock.auth.approveRegistration(registration.id, "seed-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "admin@cs.toronto.edu", password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

type Step = {
  step: string;
  status: string;
  target?: string;
  detail?: string;
  proposal_id?: string;
};

const save = async (baseUrl: string, token: string, id: string, body: Record<string, unknown>) => {
  const response = await fetch(`${baseUrl}/lab/members/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { member_type_change?: { steps: Step[] } };
  return parsed.member_type_change?.steps ?? [];
};

const dcsStep = (steps: Step[]) => steps.find((step) => step.step === "dcs_roster");

const dcsProposals = (mock: ReturnType<typeof createAdminBotMockService>) =>
  mock.store.listProposalsByType("dcs_roster.add_row");

const auditOf = (mock: ReturnType<typeof createAdminBotMockService>, type: string) =>
  mock.store.listAuditEvents().filter((event) => event.type === type);

/** Written directly: executed, approved by its own policy, and on the record as such. */
function expectWrittenDirectly(
  mock: ReturnType<typeof createAdminBotMockService>,
  proposal: AdminBotStoredProposal | undefined,
) {
  expect(proposal?.status).toBe("executed");
  expect(proposal?.approvals).toEqual([]);
  expect(proposal?.approval_requirement.requires_approval).toBe(false);
  expect(
    auditOf(mock, "proposal.auto_approved").some((event) => event.action_id === proposal?.id),
  ).toBe(true);
}

async function approveAndRun(
  baseUrl: string,
  token: string,
  proposal: AdminBotStoredProposal,
  idempotencyKey = `test-${proposal.id}`,
) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const approved = await fetch(`${baseUrl}/approvals/${proposal.id}/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ payload_hash: proposal.payload_hash }),
  });
  expect(approved.status).toBe(200);
  return fetch(`${baseUrl}/actions/${proposal.id}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dry_run: false, idempotency_key: idempotencyKey }),
  });
}

async function rosterSync(baseUrl: string) {
  const response = await fetch(`${baseUrl}/members/roster-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_TOKEN}` },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { applied: unknown[]; dcs_roster?: Step[] };
}

/** The member sheet with minnie's type edited to `type`, and everyone else as stored. */
const sheetWithMinnieAs = (type: string) => [
  ["Admin", "full", "admin@cs.toronto.edu", ""],
  ["Minnie Minor", type, "minnie@lab.test", ""],
  ["Cora Coauthor", "coauthor-major", "cora@lab.test", ""],
  ["Fern Fullmember", "full", "fern@lab.test", ""],
];

describe("a Lab Members tab save that makes somebody a major coauthor or a full member", () => {
  it("writes their row directly, under the sheet's own columns", async () => {
    const { baseUrl, mock, appended } = await startService({ dcsRows: [HOLDS_MINNIE] });
    const token = await adminToken(mock, baseUrl);

    const steps = await save(baseUrl, token, "minnie", { member_type: "coauthor-major" });

    expect(dcsStep(steps)).toMatchObject({ status: "done", target: "Minnie Minor" });
    expect(appended).toHaveLength(1);
    const [row] = appended;
    expect(row?.slice(0, 8)).toEqual([
      "Minnie Minor",
      "minnie",
      // `minnie` is taken on the sheet, so the next candidate.
      "minor",
      "minnie@lab.test",
      "coauthor-major",
      "",
      "UofT-slack-only",
      // UTORid: nothing on the record says it, so it is left for the sysadmin.
      "",
    ]);
    expect(row?.[8]).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    const [proposal] = dcsProposals(mock);
    expectWrittenDirectly(mock, proposal);
    expect(proposal?.proposed_payload).toMatchObject({
      spreadsheet_id: "dcs-sheet",
      member_id: "minnie",
      role: "coauthor-major",
      dcs_username_candidates: ["minnie", "minor", "mminor"],
    });
    const [added] = auditOf(mock, "auth.dcs_roster_row_added");
    expect(added?.details).toMatchObject({ member_id: "minnie", dcs_username: "minor" });
    expect(JSON.stringify(mock.store.listAuditEvents())).not.toMatch(/password/iu);
  });

  it("files a major coauthor's row again when they become a full member", async () => {
    // Cora has no row yet: she became a major coauthor before this filing existed.
    const { baseUrl, mock, appended } = await startService({ dcsRows: [] });
    const token = await adminToken(mock, baseUrl);

    const steps = await save(baseUrl, token, "cora", { member_type: "full" });

    expect(dcsStep(steps)?.status).toBe("done");
    expect(appended.map((row) => [row[1], row[4]])).toEqual([["cora", "full"]]);
  });

  it("files a row for a new full member added on the Members tab", async () => {
    const { baseUrl, mock, appended } = await startService({ dcsRows: [] });
    const token = await adminToken(mock, baseUrl);

    const steps = await save(baseUrl, token, "nova-newcomer", {
      name: "Nova Newcomer",
      email: "nova@lab.test",
      member_type: "full",
    });

    expect(dcsStep(steps)?.status).toBe("done");
    expect(appended.map((row) => row.slice(0, 5))).toEqual([
      ["Nova Newcomer", "nova-newcomer", "nova", "nova@lab.test", "full"],
    ]);
  });
});

describe("saves that file nothing", () => {
  it("files nothing when the role does not change or is given up", async () => {
    const { baseUrl, mock, appended } = await startService({ dcsRows: [] });
    const token = await adminToken(mock, baseUrl);

    // Still a major coauthor; then a coauthor stepping down; then a full member leaving.
    expect(
      dcsStep(
        await save(baseUrl, token, "cora", { member_type: "coauthor-major, coauthor-minor" }),
      ),
    ).toBeUndefined();
    expect(
      dcsStep(await save(baseUrl, token, "cora", { member_type: "coauthor-minor" })),
    ).toBeUndefined();
    expect(
      dcsStep(await save(baseUrl, token, "fern", { member_type: "full, alumni" })),
    ).toBeUndefined();

    expect(appended).toEqual([]);
    expect(dcsProposals(mock)).toEqual([]);
  });

  // The sheet is one row per person; a second row would be a second account request.
  it("skips somebody already on the sheet, without filing a card", async () => {
    const { baseUrl, mock, appended } = await startService({
      dcsRows: [["Minnie Minor", "minnie", "", "", "coauthor-minor"]],
    });
    const token = await adminToken(mock, baseUrl);

    const steps = await save(baseUrl, token, "minnie", { member_type: "coauthor-major" });

    expect(dcsStep(steps)).toMatchObject({ status: "skipped", target: "row 2" });
    expect(appended).toEqual([]);
    expect(dcsProposals(mock)).toEqual([]);
  });

  it("says so when the deployment names no DCS sheet", async () => {
    const { baseUrl, mock } = await startService();
    const token = await adminToken(mock, baseUrl);

    const steps = await save(baseUrl, token, "minnie", { member_type: "coauthor-major" });

    expect(dcsStep(steps)).toMatchObject({ status: "skipped" });
    expect(dcsStep(steps)?.detail).toContain("ADMINBOT_DCS_ROSTER_SHEET_ID");
    expect(dcsProposals(mock)).toEqual([]);
  });

  it("refuses a sheet that is not the DCS roster rather than filing a card that cannot land", async () => {
    const { baseUrl, mock, appended, dcsRosterSheet } = await startService({ dcsRows: [] });
    dcsRosterSheet!.read.mockResolvedValue([["Name", "Email"]]);
    const token = await adminToken(mock, baseUrl);

    const steps = await save(baseUrl, token, "minnie", { member_type: "coauthor-major" });

    expect(dcsStep(steps)).toMatchObject({ status: "failed" });
    expect(dcsStep(steps)?.detail).toContain("adminbot_internal_id");
    expect(appended).toEqual([]);
    expect(dcsProposals(mock)).toEqual([]);
  });
});

describe("the weekly sweep's joiners", () => {
  it("files a full member's row when an admin approves their enrollment", async () => {
    const { baseUrl, mock, appended } = await startService({
      dcsRows: [],
      memberSheetRows: [["Ada Lovelace", "full", "ada@example.test", ""]],
    });
    const sweep = await fetch(`${baseUrl}/onboarding/sheet-sweep/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify({}),
    });
    expect(sweep.status).toBe(200);
    // A spreadsheet row is not an authorization: nothing is filed until an admin approves.
    expect(dcsProposals(mock)).toEqual([]);

    const token = await adminToken(mock, baseUrl);
    const listed = mock.service.listPending();
    const enroll = (listed.ok ? listed.payload.proposals : []).find(
      (proposal) => proposal.type === "lab_member.enroll",
    );
    expect((await approveAndRun(baseUrl, token, enroll!)).status).toBe(200);

    expect(appended.map((row) => row.slice(0, 5))).toEqual([
      ["Ada Lovelace", "ada-lovelace", "ada", "ada@example.test", "full"],
    ]);
    // The enrollment was the admin's decision; the row it owes follows without a second card.
    expectWrittenDirectly(mock, dcsProposals(mock)[0]);
  });
});

describe("a type changed in the spreadsheet", () => {
  it("writes the row directly, with nothing left in Pending Actions", async () => {
    const { baseUrl, mock, appended } = await startService({
      dcsRows: [],
      memberSheetRows: sheetWithMinnieAs("coauthor-major"),
    });

    const synced = await rosterSync(baseUrl);

    expect(synced.applied).toHaveLength(1);
    expect(synced.dcs_roster).toEqual([
      expect.objectContaining({ step: "dcs_roster", status: "done", target: "Minnie Minor" }),
    ]);
    expect(appended.map((row) => [row[1], row[2], row[4]])).toEqual([
      ["minnie", "minnie", "coauthor-major"],
    ]);
    expectWrittenDirectly(mock, dcsProposals(mock)[0]);
    const pending = mock.service.listPending();
    expect(
      (pending.ok ? pending.payload.proposals : []).some(
        (proposal) => proposal.type === "dcs_roster.add_row",
      ),
    ).toBe(false);
  });

  // The executor reads the sheet again when it runs, so a row somebody typed in by hand between
  // the read and the write wins -- and so does one on a card filed before rows became direct.
  it("refuses to write when the person is already on the sheet by the time it runs", async () => {
    const dcsRows: string[][] = [];
    const { mock, appended } = await startService({ dcsRows });
    const created = mock.service.createProposal({
      type: "dcs_roster.add_row",
      summary: "Add Minnie Minor to the DCS roster sheet",
      target: { service: "google", channel: "sheets", target: "dcs-sheet" },
      proposed_payload: {
        spreadsheet_id: "dcs-sheet",
        member_id: "minnie",
        role: "coauthor-major",
        values: { full_name: "Minnie Minor", adminbot_internal_id: "minnie" },
      },
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    dcsRows.push(["Minnie Minor", "minnie", "mminor", "", "coauthor-major"]);

    await mock.service.execute(created.payload.id, { dry_run: false, idempotency_key: "late" });

    expect(appended).toEqual([]);
    expect(mock.store.getProposal(created.payload.id)?.status).not.toBe("executed");
    const [failed] = auditOf(mock, "auth.dcs_roster_row_failed");
    expect(String(failed?.details?.error)).toContain("already on the DCS roster sheet (row 2)");
  });

  it("files nothing on a dry run", async () => {
    const { baseUrl, mock } = await startService({
      dcsRows: [],
      memberSheetRows: sheetWithMinnieAs("coauthor-major"),
    });
    const response = await fetch(`${baseUrl}/members/roster-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { dcs_roster?: unknown }).dcs_roster).toBeUndefined();
    expect(dcsProposals(mock)).toEqual([]);
  });
});

describe("the catch-up for members who predate role-change filing", () => {
  // Rows typed in by hand before ids were reliable: Cora under a generated id with her address,
  // Fern under a generated id with her exact name. Neither may be asked for twice.
  const LEGACY_ROWS = [
    ["C. Coauthor", "mem_0001", "", "cora@lab.test", "coauthor-major"],
    ["Fern Fullmember", "mem_0002", "fern", "", "full"],
  ];

  const backfill = (
    baseUrl: string,
    body: Record<string, unknown>,
    authorization = `Bearer ${SERVICE_TOKEN}`,
  ) =>
    fetch(`${baseUrl}/members/dcs-roster/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
    });

  type BackfillBody = {
    dry_run: boolean;
    owed: number;
    already_on_sheet: Array<{ member_id: string; sheet_row: number }>;
    missing: Array<{ member_id: string; role: string }>;
    steps: Step[];
  };

  it("lists who is missing on a dry run, matching hand-typed rows by address and name", async () => {
    const { baseUrl, mock, appended } = await startService({ dcsRows: LEGACY_ROWS });

    const response = await backfill(baseUrl, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as BackfillBody;

    expect(body.dry_run).toBe(true);
    // Admin and Fern are full, Cora a major coauthor; Minnie is a minor coauthor and owed nothing.
    expect(body.owed).toBe(3);
    expect(body.already_on_sheet).toEqual([
      { member_id: "cora", sheet_row: 2 },
      { member_id: "fern", sheet_row: 3 },
    ]);
    expect(body.missing).toEqual([{ member_id: "admin", name: "Admin", role: "full" }]);
    expect(body.steps).toEqual([]);
    expect(dcsProposals(mock)).toEqual([]);
    expect(appended).toEqual([]);
  });

  it("writes the missing rows on a real run, and a second run writes no duplicates", async () => {
    const { baseUrl, mock, appended } = await startService({ dcsRows: LEGACY_ROWS });

    const first = (await (await backfill(baseUrl, { dry_run: false })).json()) as BackfillBody;
    expect(first.steps).toEqual([
      expect.objectContaining({ step: "dcs_roster", status: "done", target: "Admin" }),
    ]);
    const second = (await (await backfill(baseUrl, { dry_run: false })).json()) as BackfillBody;
    expect(second.missing).toEqual([]);
    expect(second.steps).toEqual([]);

    expect(dcsProposals(mock)).toHaveLength(1);
    expectWrittenDirectly(mock, dcsProposals(mock)[0]);
    expect(appended.map((row) => row.slice(0, 2))).toEqual([["Admin", "admin"]]);
  });

  it("lets only an admin session approve on the same click", async () => {
    const { baseUrl, mock, appended } = await startService({ dcsRows: LEGACY_ROWS });

    const refused = await backfill(baseUrl, { dry_run: false, approve: true });
    expect(refused.status).toBe(403);
    expect(dcsProposals(mock)).toEqual([]);

    const token = await adminToken(mock, baseUrl);
    const approved = await backfill(baseUrl, { dry_run: false, approve: true }, `Bearer ${token}`);
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as BackfillBody).steps[0]?.status).toBe("done");
    expect(appended.map((row) => row.slice(0, 2))).toEqual([["Admin", "admin"]]);
  });

  it("answers 503 when the deployment names no DCS sheet", async () => {
    const { baseUrl } = await startService();
    expect((await backfill(baseUrl, {})).status).toBe(503);
  });
});

describe("the guards on a direct write", () => {
  async function writtenRow() {
    const started = await startService({
      dcsRows: [],
      memberSheetRows: sheetWithMinnieAs("coauthor-major"),
    });
    await rosterSync(started.baseUrl);
    const [proposal] = dcsProposals(started.mock);
    return {
      ...started,
      proposal: proposal!,
      token: await adminToken(started.mock, started.baseUrl),
    };
  }

  // Direct is a property of this one action's policy, not a hole in the gate: the row is still a
  // typed proposal with a payload hash and an audit trail, written once.
  it("keeps the payload hash it was auto-approved against, and audits the write", async () => {
    const { mock, proposal } = await writtenRow();
    expectWrittenDirectly(mock, proposal);
    expect(proposal.payload_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(auditOf(mock, "auth.dcs_roster_row_added")).toHaveLength(1);
  });

  it("files one row however many times the executed card is executed again", async () => {
    const { baseUrl, token, proposal, appended } = await writtenRow();
    expect(appended).toHaveLength(1);
    await fetch(`${baseUrl}/actions/${proposal.id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ dry_run: false, idempotency_key: "first" }),
    });
    await fetch(`${baseUrl}/actions/${proposal.id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ dry_run: false, idempotency_key: "second" }),
    });
    expect(appended).toHaveLength(1);
  });

  // An approved card on a deployment with no sheet is an execution failure, never "done".
  it("fails closed when no sheet is wired to carry it out", async () => {
    const { mock } = await startService();
    const created = mock.service.createProposal({
      type: "dcs_roster.add_row",
      summary: "Add Minnie Minor to the DCS roster sheet",
      target: { service: "google", channel: "sheets", target: "dcs-sheet" },
      proposed_payload: {
        spreadsheet_id: "dcs-sheet",
        member_id: "minnie",
        values: { full_name: "Minnie Minor", adminbot_internal_id: "minnie" },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const approved = mock.service.approve(created.payload.id, {
      payload_hash: created.payload.payload_hash,
      approver_role: "admin",
      approver_id: "admin",
    });
    expect(approved.ok).toBe(true);
    await mock.service.execute(created.payload.id, { dry_run: false, idempotency_key: "unwired" });
    expect(mock.store.getProposal(created.payload.id)?.status).not.toBe("executed");
  });
});
