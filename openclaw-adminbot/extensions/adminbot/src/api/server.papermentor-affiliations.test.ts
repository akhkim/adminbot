// PaperMentor's roster read: each author on a title page matched to the lab roster, answered with
// the member's recorded affiliation and whether they hold Vector compute, behind its own token.
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotLabMemberInput } from "../contracts/actions.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { paperMentorAuthorAffiliations } from "./server.papermentor-affiliations.js";
import { createAdminBotMockService } from "./server.js";

const TOKEN = "papermentor-test-token";
const SERVICE_TOKEN = "test-service-token";

function member(fields: Partial<AdminBotLabMember> & { name: string }): AdminBotLabMember {
  return { id: fields.name.toLowerCase().replace(/\s+/g, "-"), ...fields } as AdminBotLabMember;
}

describe("paperMentorAuthorAffiliations", () => {
  const roster = [
    member({ name: "Ada Lovelace", affiliation: "University of Toronto", compute_access: ["vector-killarney"] }),
    member({ name: "Grace Hopper", preferred_name: "Amazing Grace", affiliation: "  ETH Zurich  " }),
    member({ name: "Alan Turing", vector_role: "postdoc" }),
    member({ name: "Wei Zhang", affiliation: "A" }),
    member({ name: "Wei Zhang", affiliation: "B" }),
  ];

  it("answers each author in order, with the recorded affiliation and Vector flag", () => {
    expect(
      paperMentorAuthorAffiliations(
        ["Ada Lovelace", "Amazing Grace", "Alan Turing", "Someone Else"],
        roster,
      ),
    ).toEqual([
      {
        author: "Ada Lovelace",
        member: { name: "Ada Lovelace", affiliation: "University of Toronto", vector: true },
      },
      { author: "Amazing Grace", member: { name: "Grace Hopper", affiliation: "ETH Zurich", vector: false } },
      { author: "Alan Turing", member: { name: "Alan Turing", vector: true } },
      { author: "Someone Else", member: null },
    ]);
  });

  it("leaves an author unmatched when two members share the name", () => {
    expect(paperMentorAuthorAffiliations(["Wei Zhang"], roster)).toEqual([
      { author: "Wei Zhang", member: null },
    ]);
  });

  it("does not count non-Vector compute as Vector", () => {
    const [answer] = paperMentorAuthorAffiliations(
      ["Ada Lovelace"],
      [member({ name: "Ada Lovelace", compute_access: ["UofT-CSlab-noDiskusage-justSlack"] })],
    );
    expect(answer.member?.vector).toBe(false);
  });
});

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

async function startService(paperMentorToken?: string) {
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    ...(paperMentorToken ? { paperMentorToken } : {}),
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
  const saved = mock.service.upsertLabMember(
    withCompleteProfile({
      id: "ada",
      name: "Ada Lovelace",
      email: "ada@lab.test",
      privilege_level: "member",
      member_type: "full",
      affiliation: "University of Toronto",
      compute_access: ["vector-killarney"],
    } as AdminBotLabMemberInput),
  );
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
  const url = `http://127.0.0.1:${address.port}/papermentor/author-affiliations`;
  return (token: string | undefined, body: unknown = { authors: ["Ada Lovelace", "Nobody"] }) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
}

describe("POST /papermentor/author-affiliations", () => {
  it("answers the roster read with the PaperMentor token, and nothing about the member beyond it", async () => {
    const post = await startService(TOKEN);
    const response = await post(TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      authors: [
        {
          author: "Ada Lovelace",
          member: { name: "Ada Lovelace", affiliation: "University of Toronto", vector: true },
        },
        { author: "Nobody", member: null },
      ],
    });
  });

  it("refuses a missing or wrong token, including the service token", async () => {
    const post = await startService(TOKEN);
    expect((await post(undefined)).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    expect((await post(SERVICE_TOKEN)).status).toBe(401);
  });

  it("does not exist when no PaperMentor token is configured", async () => {
    const post = await startService();
    expect((await post(SERVICE_TOKEN)).status).toBe(404);
  });

  it("rejects a body that is not a short list of names", async () => {
    const post = await startService(TOKEN);
    expect((await post(TOKEN, {})).status).toBe(400);
    expect((await post(TOKEN, { authors: [""] })).status).toBe(400);
    expect((await post(TOKEN, { authors: [42] })).status).toBe(400);
    expect((await post(TOKEN, { authors: Array.from({ length: 101 }, () => "A B") })).status).toBe(
      400,
    );
  });
});
