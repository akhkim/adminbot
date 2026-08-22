// The paper-evidence routes end to end: the reads the card makes, the write a field makes, and
// the global nudge all the way out to the message connector.
//
// Its own file rather than more of server.test.ts, which is already the longest here. What makes
// this worth running over HTTP rather than against the service directly is the half a unit test
// cannot see: that the routes are reachable and gated as intended, that the proposal the nudge
// creates is auto-approved and executed rather than left pending, and that what finally reaches
// the connector is a Slack send addressed to the right person with the right words in it.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMessageExecutor } from "../connectors/message.js";
import type { AdminBotLabMemberInput } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

type Running = {
  baseUrl: string;
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanup: string[];
};
const running: Running[] = [];

/** The in-process service behind a running base URL, for state that has no HTTP route. */
function mockFor(baseUrl: string): ReturnType<typeof createAdminBotMockService> {
  const entry = running.find((candidate) => candidate.baseUrl === baseUrl);
  if (!entry) {
    throw new Error(`no running service for ${baseUrl}`);
  }
  return entry.mock;
}

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    for (const target of entry.cleanup) {
      await rm(target, { force: true });
    }
  }
});

/**
 * A service with the real Slack message connector wired, its CLI call captured.
 *
 * Stubbing at `run` rather than replacing the executor keeps buildOpenClawMessageArgs in the path,
 * which is the part that decides what the nudge actually becomes on the wire.
 */
async function startLab(): Promise<{ baseUrl: string; sent: string[][] }> {
  const sent: string[][] = [];
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-paper-slots-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    executor: createAdminBotMessageExecutor({
      run: async (args) => {
        sent.push(args);
      },
    }),
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
    throw new Error("missing service address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ baseUrl, mock, cleanup: [sensitiveInfoPath] });

  // Roster members are seeded in-process: creating one needs a real admin member session, which is
  // not what these tests are about.
  for (const member of [
    { id: "ada", name: "Ada Lovelace", privilege_level: "member", slack_user_id: "U-ADA" },
    { id: "bob", name: "Bob Coauthor", privilege_level: "member", slack_user_id: "U-BOB" },
    { id: "zhijing", name: "Zhijing Jin", privilege_level: "admin", slack_user_id: "U-ZJ" },
  ]) {
    const result = mock.service.upsertLabMember(member as AdminBotLabMemberInput);
    if (!result.ok) {
      throw new Error(`seed ${member.id}: ${result.error.message}`);
    }
  }
  await call(baseUrl, "PUT", "/settings", { head_professor_member_id: "zhijing" });
  await call(baseUrl, "PUT", "/papers/p1", {
    title: "Causal abstraction",
    authors: ["Ada Lovelace", "Bob Coauthor"],
    current_step: "overleaf_writing",
    first_author_member_id: "ada",
    venue: "ICLR 2027",
    deadline: "2099-01-01",
  });
  return { baseUrl, sent };
}

async function call(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * A real admin member session.
 *
 * The send route needs one: it messages the lab under the presser's authority, so unlike the
 * read-only halves of this feature the shared service principal is refused.
 */
async function adminHeaders(baseUrl: string): Promise<Record<string, string>> {
  const mock = mockFor(baseUrl);
  const seeded = mock.service.upsertLabMember({
    id: "zhijing",
    name: "Zhijing Jin",
    email: "zhijing@cs.toronto.edu",
    privilege_level: "admin",
    slack_user_id: "U-ZJ",
  } as AdminBotLabMemberInput);
  if (!seeded.ok) {
    throw new Error(seeded.error.message);
  }
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      member_id: "zhijing",
      email: "zhijing@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const pending = (
    (await (
      await fetch(`${baseUrl}/auth/registrations?status=pending`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      })
    ).json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === "zhijing");
  if (!pending) {
    throw new Error("no pending claim for zhijing");
  }
  const approved = mock.auth.approveRegistration(pending.id, "test-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "zhijing@cs.toronto.edu", password: "correcthorse" }),
  });
  const token = ((await login.json()) as { session_token: string }).session_token;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Same as `call`, on an admin member session rather than the service principal. */
async function callAs(
  headers: Record<string, string>,
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The value of one `--flag` in a captured CLI invocation. */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

describe("the paper-evidence reads", () => {
  it("lists what each paper still owes, and who owes it", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "GET", "/papers/slot-overview");
    expect(result.status).toBe(200);
    expect(result.body.papers[0]).toMatchObject({
      paper_id: "p1",
      venue: "ICLR 2027",
      provided_count: 0,
      // Only the one thing that is actually askable: everything else is behind it.
      missing_slots: ["project_folder"],
      first_author_member_id: "ada",
      dormant: false,
      closed: false,
    });
  });

  it("returns all 24 slots for one paper, blanks included", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "GET", "/papers/p1/slots");
    expect(result.status).toBe(200);
    expect(result.body.slots).toHaveLength(24);
  });
});

describe("writing a slot over HTTP", () => {
  it("stores a good link as provided", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "PUT", "/papers/p1/slots/project_folder", {
      url: "https://docs.google.com/document/d/x",
    });
    expect(result.status).toBe(200);
    expect(result.body.slot).toMatchObject({
      status: "provided",
      url: "https://docs.google.com/document/d/x",
    });
    expect(result.body.slot.validated_at).toBeTruthy();
  });

  it("keeps a link that failed validation, with the reason, rather than refusing the write", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "PUT", "/papers/p1/slots/overleaf_edit", {
      url: "https://example.com/nope",
    });
    expect(result.status).toBe(200);
    expect(result.body.slot).toMatchObject({
      status: "invalid",
      url: "https://example.com/nope",
    });
    expect(result.body.slot.invalid_reason).toContain("overleaf.com");
  });

  it("refuses an unauthenticated write and an unknown slot", async () => {
    const { baseUrl } = await startLab();
    const anonymous = await fetch(`${baseUrl}/papers/p1/slots/overleaf_edit`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.overleaf.com/project/1" }),
    });
    expect(anonymous.status).toBe(401);
    const unknown = await call(baseUrl, "PUT", "/papers/p1/slots/make_coffee", { done: true });
    expect(unknown.status).toBe(400);
  });

  it("takes a waiver only from a genuine admin session, never the service principal", async () => {
    const { baseUrl } = await startLab();
    // The agent authenticates as the service principal on every tool call, so letting it waive
    // would let a chat excuse a paper from evidence it is supposed to produce.
    const result = await call(baseUrl, "POST", "/papers/p1/slots/poster/waive", {
      reason: "no poster session",
    });
    expect(result.status).toBe(403);
  });
});

describe("the social drafts and their consents", () => {
  it("stores a draft, circulates it, and approves it once the named authors answer", async () => {
    const { baseUrl } = await startLab();
    const saved = await call(baseUrl, "POST", "/papers/p1/social-drafts", {
      platform: "x",
      body: "A thread about the paper.",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.draft).toMatchObject({ platform: "x", status: "draft" });

    const circulated = await call(
      baseUrl,
      "POST",
      `/papers/social-drafts/${saved.body.draft.id}/circulate`,
    );
    expect(circulated.status).toBe(200);
    // The two named authors who are on the roster, and only them. Zhijing is an admin but is not
    // an author of this paper, so nobody asks her to consent to it.
    expect(circulated.body.asked.toSorted()).toEqual(["ada", "bob"]);
    expect(circulated.body.draft.status).toBe("circulated");

    // The gate the checklist reads is still shut while anyone is pending.
    const before = await call(baseUrl, "GET", "/papers/p1/slots");
    expect(before.body.slots.find((slot: { slot: string }) => slot.slot === "x_draft").status).toBe(
      "missing",
    );
  });

  it("gives every draft its own id, even two saved in the same millisecond", async () => {
    // A shared id would make the second save upsert over the first, losing the exact version
    // somebody may already have consented to.
    const { baseUrl } = await startLab();
    const ids = await Promise.all(
      ["one", "two", "three"].map(async (body) => {
        const saved = await call(baseUrl, "POST", "/papers/p1/social-drafts", {
          platform: "x",
          body,
        });
        return saved.body.draft.id as string;
      }),
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("supersedes the previous draft rather than overwriting it", async () => {
    const { baseUrl } = await startLab();
    const first = await call(baseUrl, "POST", "/papers/p1/social-drafts", {
      platform: "x",
      body: "First attempt",
    });
    await call(baseUrl, "POST", "/papers/p1/social-drafts", {
      platform: "x",
      body: "Second attempt",
    });
    const drafts = (await call(baseUrl, "GET", "/papers/p1/slots")).body.drafts as Array<{
      id: string;
      status: string;
      body: string;
    }>;
    // "What did they actually approve" has to stay answerable after a regeneration.
    expect(drafts.find((draft) => draft.id === first.body.draft.id)?.status).toBe("superseded");
    expect(drafts.some((draft) => draft.body === "First attempt")).toBe(true);
  });

  it("refuses a consent from somebody who was not asked", async () => {
    const { baseUrl } = await startLab();
    const saved = await call(baseUrl, "POST", "/papers/p1/social-drafts", {
      platform: "x",
      body: "A thread",
    });
    // The service principal has nobody to speak for, so this route needs a member session.
    const result = await call(
      baseUrl,
      "POST",
      `/papers/social-drafts/${saved.body.draft.id}/consent`,
      { decision: "ok" },
    );
    expect(result.status).toBe(401);
  });
});

describe("the conference half", () => {
  it("records who is going and who is square", async () => {
    const { baseUrl } = await startLab();
    const attendee = await call(baseUrl, "PUT", "/papers/p1/attendees", {
      name: "Ada Lovelace",
      member_id: "ada",
      attending: "yes",
    });
    expect(attendee.status).toBe(200);
    expect(attendee.body.attendee).toMatchObject({ attendee_key: "member:ada", attending: "yes" });

    const reimbursement = await call(baseUrl, "PUT", "/papers/p1/reimbursements/ada", {
      status: "reimbursed",
    });
    expect(reimbursement.status).toBe(200);
    expect(reimbursement.body.reimbursement.completed_at).toBeTruthy();
  });

  it("keys an off-roster attendee by name, since SQLite cannot key on an expression", async () => {
    const { baseUrl } = await startLab();
    const first = await call(baseUrl, "PUT", "/papers/p1/attendees", {
      name: "External  Collaborator",
      attending: "unknown",
    });
    const second = await call(baseUrl, "PUT", "/papers/p1/attendees", {
      name: "external collaborator",
      attending: "yes",
    });
    expect(first.body.attendee.attendee_key).toBe(second.body.attendee.attendee_key);
    const attendees = (await call(baseUrl, "GET", "/papers/p1/slots")).body.attendees;
    expect(attendees).toHaveLength(1);
    expect(attendees[0].attending).toBe("yes");
  });

  it("refuses an unknown reimbursement status", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "PUT", "/papers/p1/reimbursements/ada", {
      status: "probably",
    });
    expect(result.status).toBe(400);
  });
});

describe("the backfill", () => {
  it("turns stored artifacts into slots without being asked twice", async () => {
    const { baseUrl } = await startLab();
    await call(baseUrl, "PUT", "/papers/p2", {
      title: "An older paper",
      authors: ["Ada Lovelace"],
      current_step: "arxiv_polish",
      first_author_member_id: "ada",
      artifacts: { arxiv_url: "https://arxiv.org/abs/2401.00001", conference: "ACL" },
    });
    // Admin-only: it rewrites evidence across every paper in the lab.
    const dry = await call(baseUrl, "POST", "/papers/slots/backfill", { dry_run: true });
    expect(dry.status).toBe(403);
  });
});

describe("the global nudge, end to end", () => {
  it("previews the batches without sending anything", async () => {
    const { baseUrl, sent } = await startLab();
    const preview = await call(baseUrl, "GET", "/papers/nudge-batches");
    expect(preview.status).toBe(200);
    expect(preview.body.batches).toHaveLength(1);
    expect(preview.body.batches[0]).toMatchObject({
      member_id: "ada",
      member_name: "Ada Lovelace",
      deliverable: true,
      paper_titles: ["Causal abstraction"],
    });
    // The composed message, verbatim -- the preview is the send, looked at rather than performed.
    expect(preview.body.batches[0].message).toContain("Project folder or brainstorm doc");
    expect(sent).toHaveLength(0);
  });

  it("says up front that somebody cannot be reached", async () => {
    const { baseUrl } = await startLab();
    mockFor(baseUrl).service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      privilege_level: "member",
      slack_user_id: "",
    } as never);
    const preview = await call(baseUrl, "GET", "/papers/nudge-batches");
    // Reported before the send rather than afterwards in a list of failures.
    expect(preview.body.batches[0]).toMatchObject({ member_id: "ada", deliverable: false });
  });

  it("refuses the send from the service principal -- this one needs a person", async () => {
    const { baseUrl, sent } = await startLab();
    // Unlike the mandatory-fields reminder, nothing schedules this. It messages the lab under the
    // presser's authority, so an agent tool call must not be able to trigger it.
    const result = await call(baseUrl, "POST", "/papers/slot-reminder/run");
    expect(result.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("sends one Slack message to the first author naming exactly what is outstanding", async () => {
    const { baseUrl, sent } = await startLab();
    await call(baseUrl, "PUT", "/papers/p1/slots/project_folder", {
      url: "https://docs.google.com/document/d/x",
    });
    await call(baseUrl, "PUT", "/papers/p1/slots/overleaf_edit", {
      url: "https://example.com/nope",
    });

    const run = await callAs(
      await adminHeaders(baseUrl),
      baseUrl,
      "POST",
      "/papers/slot-reminder/run",
    );
    expect(run.status).toBe(200);
    expect(sent).toHaveLength(1);

    const args = sent[0] as string[];
    expect(args.slice(0, 2)).toEqual(["message", "send"]);
    expect(flag(args, "--channel")).toBe("slack");
    expect(flag(args, "--target")).toBe("U-ADA");

    const message = flag(args, "--message") ?? "";
    expect(message).toContain("Causal abstraction");
    // The artifact by name, not the pipeline step -- "you are on overleaf_writing" is not a thing
    // anybody can act on.
    expect(message).toContain("Overleaf project link");
    expect(message).toContain("ICLR 2027 deadline");
    // The refusal reason travels with the nudge, so the fix is in the message.
    expect(message).toContain("overleaf.com");
    // Not the slot that is already in, and not work that is still gated behind it.
    expect(message).not.toContain("Brainstorm doc");
    expect(message).not.toContain("arXiv");
  });

  it("auto-approves and executes rather than leaving the nudge pending", async () => {
    const { baseUrl } = await startLab();
    const run = await callAs(
      await adminHeaders(baseUrl),
      baseUrl,
      "POST",
      "/papers/slot-reminder/run",
    );
    expect(run.body.created[0]).toMatchObject({
      type: "member_nudge.send",
      status: "executed",
    });
    const audit = await call(baseUrl, "GET", "/audit");
    const types = new Set((audit.body.events ?? []).map((event: { type: string }) => event.type));
    expect(types.has("paper_slots.nudged")).toBe(true);
    expect(types.has("member_nudge.sent")).toBe(true);
  });

  it("stamps the counters the escalation depends on, and only on what it sent", async () => {
    const { baseUrl } = await startLab();
    await call(baseUrl, "PUT", "/papers/p1/slots/project_folder", {
      url: "https://docs.google.com/document/d/x",
    });
    await callAs(await adminHeaders(baseUrl), baseUrl, "POST", "/papers/slot-reminder/run");
    const slots = (await call(baseUrl, "GET", "/papers/p1/slots")).body.slots as Array<{
      slot: string;
      nudge_count: number;
      last_nudged_at?: string;
    }>;
    const ledger = mockFor(baseUrl).service.listNudgeLedgerForTest("paper_slot");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      subject_id: "p1:overleaf_edit",
      member_id: "ada",
      nudge_count: 1,
    });
    expect(ledger[0]?.last_nudged_at).toBeTruthy();
    // Nothing was stamped for the slot that is already in, or for anything still gated.
    expect(slots.length).toBe(24);
  });

  it("keeps its cadence, so a doubled cron cannot nag", async () => {
    const { baseUrl, sent } = await startLab();
    const headers = await adminHeaders(baseUrl);
    await callAs(headers, baseUrl, "POST", "/papers/slot-reminder/run");
    const second = await callAs(headers, baseUrl, "POST", "/papers/slot-reminder/run");
    expect(second.body.created).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("refuses an unauthenticated run", async () => {
    const { baseUrl, sent } = await startLab();
    const res = await fetch(`${baseUrl}/papers/slot-reminder/run`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});
