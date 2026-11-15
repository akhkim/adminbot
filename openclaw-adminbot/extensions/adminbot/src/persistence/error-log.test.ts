import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  adminBotErrorFingerprint,
  adminBotErrorGroupCap,
  adminBotErrorMemberCap,
  adminBotErrorReportsPerMinute,
  parseAdminBotErrorReport,
  scrubErrorText,
  type AdminBotErrorReport,
} from "../contracts/error-log.js";
import { createErrorLogFromDatabase, createMemoryErrorLog, type ErrorLog } from "./error-log.js";

const boom: AdminBotErrorReport = {
  kind: "error",
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'name')",
  stack: "TypeError: Cannot read\n    at renderRow (https://lab.example/assets/app.js:10:42)",
  page: "/papers",
};

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes));
}

const stores: Array<[string, () => ErrorLog]> = [
  ["memory", () => createMemoryErrorLog()],
  ["sqlite", () => createErrorLogFromDatabase(new DatabaseSync(":memory:"))],
];

describe.each(stores)("error log (%s)", (_name, create) => {
  it("counts repeats of one problem in one group and remembers who hit it", () => {
    const log = create();
    log.record(boom, { memberId: "ada", now: at(0) });
    log.record(boom, { memberId: "ada", now: at(1) });
    // A new build moves the line numbers; it is still the same bug.
    const moved = { ...boom, stack: boom.stack!.replace(":10:42", ":99:7"), page: "/calendar" };
    log.record(moved, { memberId: "grace", now: at(2) });

    const groups = log.list();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      count: 3,
      member_ids: ["ada", "grace"],
      first_seen_at: at(0).toISOString(),
      last_seen_at: at(2).toISOString(),
      message: boom.message,
    });
    expect(groups[0]?.sample_stack).toContain(":99:7");
  });

  it("keeps different problems apart and lists the most recent first", () => {
    const log = create();
    log.record(boom, { now: at(0) });
    log.record(
      { kind: "api", message: "HTTP 500", api_method: "GET", api_path: "/papers", api_status: 500 },
      { now: at(1) },
    );
    log.record(
      { kind: "api", message: "HTTP 500", api_method: "GET", api_path: "/rooms", api_status: 500 },
      { now: at(2) },
    );
    expect(log.list().map((group) => group.api_path)).toEqual(["/rooms", "/papers", undefined]);
    expect(log.list({ limit: 1 })).toHaveLength(1);
  });

  it("stops listing members past the cap and says so", () => {
    const log = create();
    for (let index = 0; index < adminBotErrorMemberCap + 3; index += 1) {
      log.record(boom, { memberId: `member-${index}`, now: at(index) });
    }
    const [group] = log.list();
    expect(group?.member_ids).toHaveLength(adminBotErrorMemberCap);
    expect(group?.members_capped).toBe(true);
    expect(group?.count).toBe(adminBotErrorMemberCap + 3);
  });

  it("hides a resolved group until the problem comes back", () => {
    const log = create();
    const { id } = log.record(boom, { memberId: "ada", now: at(0) });
    expect(log.resolve(id, "admin", at(1))).toMatchObject({ resolved_by: "admin" });
    expect(log.list()).toEqual([]);
    expect(log.list({ includeResolved: true })).toHaveLength(1);
    expect(log.resolve("err_missing", "admin")).toBeUndefined();

    log.record(boom, { memberId: "ada", now: at(2) });
    const [reopened] = log.list();
    expect(reopened?.count).toBe(2);
    expect(reopened?.resolved_at).toBeUndefined();
  });

  it("drops the least recently seen groups past the cap, and anything too old", () => {
    const log = create();
    for (let index = 0; index < adminBotErrorGroupCap + 5; index += 1) {
      log.record({ kind: "error", message: `problem ${"x".repeat(index)}` }, { now: at(index) });
    }
    const kept = log.list({ limit: 10_000, includeResolved: true });
    expect(kept).toHaveLength(adminBotErrorGroupCap);
    expect(kept.at(-1)?.last_seen_at).toBe(at(5).toISOString());

    const muchLater = new Date(at(0).getTime() + 200 * 86_400_000);
    log.record({ kind: "error", message: "fresh" }, { now: muchLater });
    expect(log.list({ includeResolved: true }).map((group) => group.message)).toEqual(["fresh"]);
  });

  it("refuses a reporter past the per-minute cap, then lets them back in", () => {
    const log = create();
    for (let index = 0; index < adminBotErrorReportsPerMinute; index += 1) {
      expect(log.accepts("ada", at(0))).toBe(true);
    }
    expect(log.accepts("ada", at(0))).toBe(false);
    expect(log.accepts("grace", at(0))).toBe(true);
    expect(log.accepts("ada", at(1))).toBe(true);
  });
});

describe("error report validation", () => {
  it("requires a known kind and a message, and never accepts a server report", () => {
    expect(parseAdminBotErrorReport({ kind: "error" }).ok).toBe(false);
    expect(parseAdminBotErrorReport({ kind: "nope", message: "x" }).ok).toBe(false);
    expect(parseAdminBotErrorReport({ kind: "server", message: "x" }).ok).toBe(false);
  });

  it("truncates long fields and drops what it does not know", () => {
    const parsed = parseAdminBotErrorReport({
      kind: "error",
      message: "m ".repeat(2000),
      stack: "s ".repeat(5000),
      member_id: "mallory",
      body: { secret: true },
      api_path: "/papers",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.report.message.length).toBeLessThanOrEqual(500);
    expect(parsed.report.stack?.length).toBeLessThanOrEqual(4000);
    expect(Object.keys(parsed.report).toSorted()).toEqual(["kind", "message", "stack"]);
  });

  it("strips query strings, tokens and email addresses", () => {
    const parsed = parseAdminBotErrorReport({
      kind: "api",
      message:
        "GET https://lab.example/papers?invite=abc123&q=secret failed for ada@cs.toronto.edu with Bearer abc.def.ghi",
      stack: "at load (https://lab.example/assets/app.js?v=9f8e:1:2)",
      page: "/papers?search=private#frag",
      api_method: "get",
      api_path: "/lab/members?email=ada@cs.toronto.edu",
      api_status: 503,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const serialized = JSON.stringify(parsed.report);
    for (const leaked of ["abc123", "secret", "private", "frag", "ada@", "abc.def.ghi", "v=9f8e"]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(parsed.report).toMatchObject({
      page: "/papers",
      api_method: "GET",
      api_path: "/lab/members",
      api_status: 503,
    });
    expect(scrubErrorText(`token ${"a".repeat(40)}`)).toBe("token [redacted]");
  });

  it("groups one route across record ids, and apart across statuses", () => {
    const base = { kind: "api", message: "HTTP 500", api_method: "GET" } as const;
    const first = adminBotErrorFingerprint({ ...base, api_path: "/papers/1234", api_status: 500 });
    const second = adminBotErrorFingerprint({ ...base, api_path: "/papers/9876", api_status: 500 });
    const other = adminBotErrorFingerprint({ ...base, api_path: "/papers/1234", api_status: 503 });
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });
});
