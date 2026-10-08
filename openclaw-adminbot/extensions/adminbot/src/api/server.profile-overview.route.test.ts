// GET /members/profile-overview over HTTP: the Lab Overview rows leave out what the page fills in,
// and the service pages, filters and counts the roster rather than sending all of it.
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_LIST_PAGE_SIZE } from "../contracts/list-page.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: { mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }[] = [];

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
    await rm(entry.cleanup, { force: true });
  }
});

describe("GET /members/profile-overview", () => {
  it("sends a dormant member as the fields that tell them apart, and the roll-up in full", async () => {
    const sensitiveInfoPath = path.join(
      os.tmpdir(),
      `adminbot-profile-overview-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN, sensitiveInfoPath });
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    running.push({ mock, cleanup: sensitiveInfoPath });
    const address = mock.server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing mock service address");
    }
    for (const [id, privilege_level] of [
      ["ada", "member"],
      ["zhijing", "admin"],
    ] as const) {
      expect(mock.service.upsertLabMember({ id, name: id, privilege_level }).ok).toBe(true);
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/members/profile-overview`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Record<string, unknown>[];
      mandatory_field_count: number;
      adoption: { members: number };
    };
    const full = mock.service.listMemberProfileOverview();
    if (!full.ok) {
      throw new Error("overview failed");
    }
    expect(body.adoption).toEqual(full.payload.adoption);
    expect(body.mandatory_field_count).toBe(full.payload.mandatory_field_count);

    const ada = body.members.find((row) => row.id === "ada");
    const admin = body.members.find((row) => row.id === "zhijing");
    // Creating the record is itself an audited edit, so `activity` is sent; the unit test covers
    // a row whose activity is all zero.
    for (const key of ["privilege_level", "projects", "timeline"]) {
      expect(ada).not.toHaveProperty(key);
    }
    expect(admin?.privilege_level).toBe("admin");
    // Gaps are what the page is for: a member who owes fields still lists them.
    const fullAda = full.payload.members.find((row) => row.id === "ada");
    expect(ada?.missing_fields ?? []).toEqual(fullAda?.missing_fields);
  });

  async function start(memberCount: number) {
    const sensitiveInfoPath = path.join(
      os.tmpdir(),
      `adminbot-profile-overview-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    const mock = createAdminBotMockService({ serviceToken: SERVICE_TOKEN, sensitiveInfoPath });
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    running.push({ mock, cleanup: sensitiveInfoPath });
    const address = mock.server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing mock service address");
    }
    for (let index = 0; index < memberCount; index += 1) {
      const id = `m${String(index).padStart(3, "0")}`;
      expect(
        mock.service.upsertLabMember({
          id,
          name: index % 5 === 0 ? `Searchable ${id}` : `Member ${id}`,
          privilege_level: "member",
          ...(index % 7 === 0 ? { member_type: "coauthor-major" } : {}),
        }).ok,
      ).toBe(true);
    }
    const base = `http://127.0.0.1:${address.port}`;
    const read = async (query: string) => {
      const res = await fetch(`${base}/members/profile-overview${query}`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { mock, base, read };
  }

  it("sends one page of the filtered roster, with the whole list's total and remind count", async () => {
    const { read } = await start(45);
    const first = await read("?gap=all");
    expect(first.status).toBe(200);
    expect((first.body.members as unknown[]).length).toBe(ADMIN_LIST_PAGE_SIZE);
    expect(first.body.total).toBe(45);
    expect(first.body.next_cursor).toBe(String(ADMIN_LIST_PAGE_SIZE));
    // Everyone owes profile fields in a fresh roster, so all 45 are owed a reminder.
    expect(first.body.summary).toEqual({ remind_count: 45 });
    expect((first.body.adoption as { members: number }).members).toBe(45);

    const last = await read("?gap=all&cursor=40");
    expect((last.body.members as unknown[]).length).toBe(5);
    expect(last.body).not.toHaveProperty("next_cursor");

    // The search runs over every row, not the page: nine names match, spread across the roster.
    const searched = await read("?gap=all&q=searchable");
    expect(searched.body.total).toBe(9);
    expect(searched.body.summary).toEqual({ remind_count: 9 });
    const typed = await read("?gap=all&member_types=coauthor-major");
    expect(typed.body.total).toBe(7);
  });

  it("refuses a page past the ceiling or a filter it does not know", async () => {
    const { read } = await start(1);
    expect((await read("?limit=51")).status).toBe(400);
    expect((await read("?cursor=x")).status).toBe(400);
    expect((await read("?gap=everything")).status).toBe(400);
  });

  it("sends My Desk each column's head and every column's true length", async () => {
    const { read } = await start(45);
    const desk = await read("?view=desk");
    expect(desk.status).toBe(200);
    // A fresh roster: all 45 owe profile fields and timeline entries, and nobody has a paper.
    expect(desk.body.desk).toEqual({ profile: 45, timeline: 45, papers: 0, people: 45 });
    expect((desk.body.members as unknown[]).length).toBe(ADMIN_LIST_PAGE_SIZE);
    expect(desk.body).not.toHaveProperty("next_cursor");
  });

  it("reminds by filter, and a filter matching nobody sends to nobody rather than everyone", async () => {
    const { base } = await start(3);
    const res = await fetch(`${base}/members/mandatory-fields-reminder/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filter: "q=nobody-by-this-name" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: [], skipped: [] });
  });
});
