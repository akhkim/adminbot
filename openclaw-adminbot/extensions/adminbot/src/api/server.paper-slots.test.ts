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

type Running = { mock: ReturnType<typeof createAdminBotMockService>; cleanup: string[] };
const running: Running[] = [];

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
  running.push({ mock, cleanup: [sensitiveInfoPath] });

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
  const baseUrl = `http://127.0.0.1:${address.port}`;
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
      required_count: 22,
      // Only the one thing that is actually askable: everything else is behind it.
      missing_slots: ["brainstorm_doc"],
      first_author_member_id: "ada",
      dormant: false,
      closed: false,
    });
  });

  it("returns all 23 slots for one paper, blanks included", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "GET", "/papers/p1/slots");
    expect(result.status).toBe(200);
    expect(result.body.slots).toHaveLength(23);
  });
});

describe("writing a slot over HTTP", () => {
  it("stores a good link as provided", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "PUT", "/papers/p1/slots/brainstorm_doc", {
      url: "https://example.com/doc",
    });
    expect(result.status).toBe(200);
    expect(result.body.slot).toMatchObject({ status: "provided", url: "https://example.com/doc" });
    expect(result.body.slot.validated_at).toBeTruthy();
  });

  it("keeps a link that failed validation, with the reason, rather than refusing the write", async () => {
    const { baseUrl } = await startLab();
    const result = await call(baseUrl, "PUT", "/papers/p1/slots/overleaf", {
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
    const anonymous = await fetch(`${baseUrl}/papers/p1/slots/overleaf`, {
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

describe("the global nudge, end to end", () => {
  it("sends one Slack message to the first author naming exactly what is outstanding", async () => {
    const { baseUrl, sent } = await startLab();
    await call(baseUrl, "PUT", "/papers/p1/slots/brainstorm_doc", {
      url: "https://example.com/doc",
    });
    await call(baseUrl, "PUT", "/papers/p1/slots/overleaf", { url: "https://example.com/nope" });

    const run = await call(baseUrl, "POST", "/papers/slot-reminder/run");
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
    expect(message).toContain("Overleaf project");
    expect(message).toContain("ICLR 2027 deadline");
    // The refusal reason travels with the nudge, so the fix is in the message.
    expect(message).toContain("overleaf.com");
    // Not the slot that is already in, and not work that is still gated behind it.
    expect(message).not.toContain("Brainstorm doc");
    expect(message).not.toContain("arXiv");
  });

  it("auto-approves and executes rather than leaving the nudge pending", async () => {
    const { baseUrl } = await startLab();
    const run = await call(baseUrl, "POST", "/papers/slot-reminder/run");
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
    await call(baseUrl, "PUT", "/papers/p1/slots/brainstorm_doc", {
      url: "https://example.com/doc",
    });
    await call(baseUrl, "POST", "/papers/slot-reminder/run");
    const slots = (await call(baseUrl, "GET", "/papers/p1/slots")).body.slots as Array<{
      slot: string;
      nudge_count: number;
      last_nudged_at?: string;
    }>;
    const overleaf = slots.find((slot) => slot.slot === "overleaf");
    expect(overleaf?.nudge_count).toBe(1);
    expect(overleaf?.last_nudged_at).toBeTruthy();
    // Nothing was sent about the slot that is already in, or about anything still gated.
    expect(slots.find((slot) => slot.slot === "brainstorm_doc")?.nudge_count).toBe(0);
    expect(slots.find((slot) => slot.slot === "arxiv")?.nudge_count).toBe(0);
  });

  it("keeps its cadence, so a doubled cron cannot nag", async () => {
    const { baseUrl, sent } = await startLab();
    await call(baseUrl, "POST", "/papers/slot-reminder/run");
    const second = await call(baseUrl, "POST", "/papers/slot-reminder/run");
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
