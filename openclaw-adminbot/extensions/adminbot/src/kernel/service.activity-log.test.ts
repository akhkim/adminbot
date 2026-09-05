// The two append-only logs: every sign-in, and every field change with the member who made it.
//
// What these are guarding is the difference between a latest-stamp and a history. The roster
// already had `last_login_at` and `provided_by_member_id`; both are destroyed by the next write,
// which is how a single bulk provisioning pass in 2026-08 left 145 members holding identical
// timestamps and no way to tell a real sign-in from a script's. Every test below is about a case
// where the latest-stamp answer and the log's answer differ.
import { describe, expect, it } from "vitest";
import { paperSlotId, profileSlotId } from "../contracts/activity-log.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

// Grace exists in every fixture because an actor is always a member: the admin-edit tests read
// back the acting member's own history, and that read checks the roster.
function serviceWithMember(id = "ada"): AdminBotService {
  const service = new AdminBotService();
  unwrap(
    service.upsertLabMember({
      id,
      name: "Ada Lovelace",
      privilege_level: "member",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      id: "grace",
      name: "Grace Hopper",
      privilege_level: "admin",
    } as never),
  );
  return service;
}

describe("update events", () => {
  it("records one row per changed field, attributed to the member who typed", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Toronto" } as never, {
        source: "member",
        actor: "ada",
      }),
    );
    const updates = unwrap(service.listUpdateEventsByMember("ada")).updates;
    expect(updates.map((event) => event.slot_id)).toContain(profileSlotId("location"));
    const location = updates.find((event) => event.slot_id === profileSlotId("location"));
    expect(location?.source).toBe("member");
    expect(location?.member_id).toBe("ada");
    // Absent, not equal to the actor: a self-edit is a null check everywhere downstream.
    expect(location?.subject_member_id).toBeUndefined();
  });

  it("does not record a save that changes nothing", () => {
    const service = serviceWithMember();
    const patch = {
      id: "ada",
      name: "Ada Lovelace",
      location: "Toronto",
    } as never;
    unwrap(service.upsertLabMember(patch, { source: "member", actor: "ada" }));
    const afterFirst = unwrap(service.listUpdateEventsByMember("ada")).updates.length;
    // Re-submitting the same form is the common case. Logging it would say somebody had been
    // active on a day they only looked.
    unwrap(service.upsertLabMember(patch, { source: "member", actor: "ada" }));
    expect(unwrap(service.listUpdateEventsByMember("ada")).updates.length).toBe(afterFirst);
  });

  it("names the actor and the subject separately when an admin edits somebody else", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Zurich" } as never, {
        source: "admin",
        actor: "grace",
      }),
    );
    // The row belongs to Grace, not Ada: this is the distinction the adoption rate is built on,
    // and crediting Ada for a field an admin filled in is exactly the error it exists to avoid.
    // Ada still has the `import` rows from her own creation, so this asks about the edited field
    // rather than about the count.
    const adaOnLocation = unwrap(service.listUpdateEventsByMember("ada")).updates.filter(
      (event) => event.slot_id === profileSlotId("location"),
    );
    expect(adaOnLocation).toEqual([]);
    // By slot, not by position: Grace's own creation rows are in her history too.
    const byAdmin = unwrap(service.listUpdateEventsByMember("grace")).updates.find(
      (event) => event.slot_id === profileSlotId("location"),
    );
    expect(byAdmin?.subject_member_id).toBe("ada");
    expect(byAdmin?.source).toBe("admin");
  });

  it("defaults an unattributed write to import, so a sync cannot look self-authored", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        location: "Bonn",
      } as never),
    );
    const updates = unwrap(service.listUpdateEventsByMember("ada")).updates;
    expect(updates.every((event) => event.source === "import")).toBe(true);
  });

  it("keeps every writer of one slot, not just the last", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Toronto" } as never, {
        source: "member",
        actor: "ada",
      }),
    );
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Zurich" } as never, {
        source: "admin",
        actor: "grace",
      }),
    );
    // The member record now says only "Zurich, last touched by Grace". The log still knows Ada
    // filled it in first, which is the fact the adoption rate needs and the record has lost.
    const history = unwrap(service.listUpdateEventsBySlot(profileSlotId("location"))).updates;
    expect(history).toHaveLength(2);
    expect(history.map((event) => event.source)).toEqual(["admin", "member"]);
  });

  it("namespaces profile and paper-slot ids so they share a table without colliding", () => {
    expect(profileSlotId("location")).not.toBe(paperSlotId("paper-1", "location"));
  });

  it("404s for a member who does not exist rather than returning an empty history", () => {
    const service = serviceWithMember();
    const result = service.listUpdateEventsByMember("nobody");
    expect(result.ok).toBe(false);
  });
});

describe("login events", () => {
  it("has no rows for a member who has never signed in", () => {
    const service = serviceWithMember();
    expect(unwrap(service.listLoginEvents("ada")).logins).toEqual([]);
  });

  it("404s for a member who does not exist", () => {
    expect(serviceWithMember().listLoginEvents("nobody").ok).toBe(false);
  });
});

// The per-object reads: "who has been in this record", asked of a profile and of a paper.
//
// The lab-wide feed these replaced answered the question only by making somebody scroll past
// everybody else's work. The rows are the same rows; what changed is what you may ask for.
describe("recent updates", () => {
  it("names the actor and the field on a member's record", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Toronto" } as never, {
        source: "admin",
        actor: "grace",
      }),
    );
    const [row] = unwrap(service.listRecentUpdatesForMember("ada")).updates;
    expect(row).toMatchObject({
      actor_member_id: "grace",
      actor_name: "Grace Hopper",
      subject_member_id: "ada",
      field_key: "location",
      source: "admin",
    });
  });

  // A self-edit carries no subject, so the naive query -- rows whose subject is Ada -- would show
  // her every correction an admin made and none of her own work.
  it("includes the member's own edits, which carry no subject at all", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Toronto" } as never, {
        source: "member",
        actor: "ada",
      }),
    );
    unwrap(
      service.upsertLabMember({ id: "ada", name: "Ada Lovelace", role: "PhD Student" } as never, {
        source: "admin",
        actor: "grace",
      }),
    );
    const actors = unwrap(service.listRecentUpdatesForMember("ada")).updates.map(
      (row) => row.actor_member_id,
    );
    expect(actors).toContain("ada");
    expect(actors).toContain("grace");
  });

  it("does not put one member's record in another's history", () => {
    const service = serviceWithMember();
    unwrap(
      service.upsertLabMember({ id: "grace", name: "Grace Hopper", location: "Boston" } as never, {
        source: "member",
        actor: "grace",
      }),
    );
    expect(unwrap(service.listRecentUpdatesForMember("ada")).updates).toEqual([]);
  });

  it("gives the newest first and honours the limit", () => {
    const service = serviceWithMember();
    for (const location of ["Toronto", "Zurich", "Boston"]) {
      unwrap(
        service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location } as never, {
          source: "member",
          actor: "ada",
        }),
      );
    }
    const updates = unwrap(service.listRecentUpdatesForMember("ada", 2)).updates;
    expect(updates).toHaveLength(2);
    expect(updates[0]?.at >= (updates[1]?.at ?? "")).toBe(true);
  });

  // An unattributed pass -- the roster importer -- must not read as the member editing themselves.
  it("does not credit an import to the member whose record it touched", () => {
    const service = serviceWithMember();
    unwrap(service.upsertLabMember({ id: "ada", name: "Ada Lovelace", location: "Oslo" } as never));
    expect(unwrap(service.listRecentUpdatesForMember("ada")).updates).toEqual([]);
  });

  it("has no history for a member who is not on the roster", () => {
    expect(serviceWithMember().listRecentUpdatesForMember("nobody")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("a paper's history", () => {
  function serviceWithPaper() {
    const service = serviceWithMember();
    unwrap(
      service.upsertPaper(
        { id: "cais", title: "Causal abstraction", authors: ["Ada Lovelace"] } as never,
        { source: "member", actor: "ada" },
      ),
    );
    return service;
  }

  it("covers the record and its evidence slots, and nothing else's", () => {
    const service = serviceWithPaper();
    unwrap(
      service.upsertPaper(
        { id: "other", title: "Other paper", authors: ["Grace Hopper"] } as never,
        { source: "member", actor: "grace" },
      ),
    );
    const updates = unwrap(
      service.listRecentUpdatesForPaper("cais", { memberId: "ada", isAdmin: false }),
    ).updates;
    expect(updates.length).toBeGreaterThan(0);
    for (const row of updates) {
      expect(row.paper_id).toBe("cais");
    }
  });

  // Same rule the paper's own checklist follows: the history must not be a way around it.
  it("refuses a member who did not author it, and allows an admin", () => {
    const service = serviceWithPaper();
    expect(
      service.listRecentUpdatesForPaper("cais", { memberId: "grace", isAdmin: false }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      service.listRecentUpdatesForPaper("cais", { memberId: "grace", isAdmin: true }),
    ).toMatchObject({ ok: true });
  });

  it("has no history for a paper that does not exist", () => {
    expect(serviceWithPaper().listRecentUpdatesForPaper("nope", { isAdmin: true })).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
