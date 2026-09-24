// Where the viewer's own work sits in the Collaborate tab's lists.
//
// An administrator reads the whole lab here; that is the access right, and it stays. What it
// cost was orientation: the tab opens on somebody's own projects and offers, and those sat
// wherever store order or a recency sort happened to put them -- an admin looking for their own
// paper scrolled the lab to find it.
//
// So access and order are answered separately now. can_manage still decides what is listed and
// what carries controls; authorship decides what comes first. Discover is deliberately not
// sorted this way: its order is the caller's and its pagination cursor is built from those same
// columns, so re-sorting it would break paging through the lab.
import { expect, it } from "vitest";
import { createAdminBotMockService } from "../api/server.js";

it("shows an administrator the whole lab, with their own papers first", () => {
  const mock = createAdminBotMockService();
  try {
    for (const id of ["alice", "bob", "admin"]) {
      mock.service.upsertLabMember({
        id,
        name: id,
        email: `${id}@lab.test`,
        privilege_level: id === "admin" ? "admin" : "member",
      });
    }
    // Deliberately stored with the admin's own paper last, so store order cannot be what puts it
    // first below.
    for (const [id, title, author] of [
      ["pa", "Alice paper", "alice"],
      ["pb", "Bob paper", "bob"],
      ["px", "Admin paper", "admin"],
    ] as const) {
      mock.service.upsertPaper({
        id,
        title,
        authors: [author],
        first_author_member_id: author,
        current_step: "brainstorming",
      });
    }
    const service = mock.service.labSharing();
    const draft = { description: "tasks", tags: [], members_needed: 1, hours_per_week: 2 };
    expect(service.save("alice", "pa", draft).ok).toBe(true);
    expect(service.save("bob", "pb", draft).ok).toBe(true);
    expect(service.save("admin", "px", draft).ok).toBe(true);
    // Offers on two different people's papers, the admin's own posted first so recency alone
    // would put it last.
    expect(service.interest("bob", "px", { hours_per_week: 1, note: "on the admin's" }).ok).toBe(
      true,
    );
    expect(service.interest("bob", "pa", { hours_per_week: 1, note: "on alice's" }).ok).toBe(true);

    const view = (id: string, managedOnly: boolean) => {
      const result = service.list(id, managedOnly);
      if (!result.ok) throw new Error("unexpected failure");
      return {
        projects: result.payload.projects.map((project) => project.id),
        requests: result.payload.requests.map((request) => request.paper_id),
        interests: result.payload.interests.map((interest) => interest.paper_id),
      };
    };

    // The access right is unchanged: the admin still reads every paper, every request and every
    // offer in the lab. Only the order moved.
    for (const managedOnly of [true, false]) {
      const seen = view("admin", managedOnly);
      expect(seen.projects.toSorted()).toEqual(["pa", "pb", "px"]);
      expect(seen.requests.toSorted()).toEqual(["pa", "pb", "px"]);
      expect(seen.projects[0]).toBe("px");
      expect(seen.requests[0]).toBe("px");
      // Beating a recency sort, not just store order: the offer on alice's paper is newer.
      expect(seen.interests[0]).toBe("px");
    }

    // A member's own view is unaffected -- they only ever had their own to begin with.
    expect(view("alice", true)).toMatchObject({ projects: ["pa"], requests: ["pa"] });
    expect(view("bob", true)).toMatchObject({ projects: ["pb"], requests: ["pb"] });

    // Discover keeps the caller's ordering, because its cursor is built from those columns.
    const discovered = service.discover("admin", new URLSearchParams({ sort: "title" }));
    if (!discovered.ok) throw new Error("unexpected failure");
    expect(discovered.payload.requests.map((request) => request.title)).toEqual([
      "Admin paper",
      "Alice paper",
      "Bob paper",
    ]);
    expect(discovered.payload.requests.every((request) => request.can_manage)).toBe(true);
  } finally {
    mock.close?.();
  }
});
