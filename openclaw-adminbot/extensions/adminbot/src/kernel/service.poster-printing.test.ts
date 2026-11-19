// Poster print batches at the service boundary: who sees and changes what, that an author's answer
// lands on the paper's checklist, and that the daily sweep files each message once and withdraws
// the ones that stopped applying.
import { describe, expect, it, vi } from "vitest";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const DATASET = [
  {
    id: "neurips2026_main",
    name: "NeurIPS 2026",
    venue_type: "conference",
    venue_group: "NeurIPS 2026",
    venue_family: "NeurIPS",
    deadline_aoe: "2026-05-15 23:59:59",
    conference_location: "Sydney, Australia; Atlanta, USA; Paris, France",
    schedule: [
      { milestone: "conference", label: "Main conference — Sydney", starts: "2026-12-08", ends: "2026-12-10" },
      { milestone: "conference", label: "Main conference — Atlanta", starts: "2026-12-10", ends: "2026-12-11" },
      { milestone: "conference", label: "Main conference — Paris", starts: "2026-12-09", ends: "2026-12-11" },
    ],
  },
];

const PARIS = "neuripsparis:2026";

function lab(start = "2026-11-20T09:00:00Z") {
  const clock = { now: new Date(start) };
  const store = new AdminBotMemoryStore();
  const execute = vi.fn(async () => ({ handled: true }));
  const service = new AdminBotService(store, {
    deadlineDataset: () => DATASET,
    executor: { execute },
    now: () => clock.now,
  });
  const members = [
    { id: "ada", name: "Ada Lovelace", privilege_level: "member", slack_user_id: "UADA" },
    { id: "bob", name: "Bob Berlin", privilege_level: "member", slack_user_id: "UBOB" },
    { id: "rahul", name: "Rahul Printer", privilege_level: "member", slack_user_id: "URAHUL" },
    { id: "cy", name: "Cy Admin", privilege_level: "admin", slack_user_id: "UCY" },
    { id: "quiet", name: "Quiet Person", privilege_level: "member" },
  ];
  for (const member of members) {
    unwrap(service.upsertLabMember({ status: "active", member_type: "full", ...member } as never));
  }
  const paper = (id: string, author: { id: string; name: string }) =>
    unwrap(
      service.upsertPaper({
        id,
        title: `Paper ${id}`,
        authors: [author.name],
        author_links: [{ name: author.name, member_id: author.id }],
        current_step: "overleaf_writing",
        first_author_member_id: author.id,
        venue_decision: "accept",
        accepted_venue: "NeurIPS",
        accepted_year: 2026,
        presentation_type: "poster",
      } as never),
    );
  paper("ada-paper", { id: "ada", name: "Ada Lovelace" });
  paper("bob-paper", { id: "bob", name: "Bob Berlin" });
  const posters = () => service.posterPrinting();
  const admin = { memberId: "cy", admin: true };
  unwrap(
    posters().saveBatch(
      "default",
      { printer_member_id: "rahul", print_location: "MPI Tübingen" },
      "cy",
    ),
  );
  const pending = () =>
    store
      .listProposalsByType("slack.send_message")
      .filter((proposal) => proposal.status === "pending");
  return { service, store, clock, posters, admin, pending, execute };
}

describe("who sees what", () => {
  it("gives admins everything, the printer their batches, and an author only their own papers", () => {
    const { posters, admin } = lab();
    const all = unwrap(posters().overview(admin));
    expect(all.can_manage).toBe(true);
    expect(all.batches.map((view) => view.conference_key).toSorted()).toEqual([
      "neuripsatlanta:2026",
      PARIS,
      "neuripssydney:2026",
    ]);
    expect(all.settings).toEqual([expect.objectContaining({ conference_key: "default" })]);
    expect(all.printer_candidates?.map((c) => c.member_id)).toContain("rahul");

    const printer = unwrap(posters().overview({ memberId: "rahul", admin: false }));
    expect(printer.printable.toSorted()).toEqual(all.printable.toSorted());
    expect(printer.settings).toBe(undefined);
    expect(printer.can_manage).toBe(false);

    const ada = unwrap(posters().overview({ memberId: "ada", admin: false }));
    expect(ada.printable).toEqual([]);
    expect(ada.batches.flatMap((view) => view.papers.map((p) => p.paper_id))).toEqual([
      "ada-paper",
      "ada-paper",
      "ada-paper",
    ]);
  });

  it("keeps a paper's options to its authors and returns null when there is nothing to print", () => {
    const { service, posters } = lab();
    expect(posters().paperOptions("ada-paper", { memberId: "bob", admin: false })).toMatchObject({
      ok: false,
      status: 403,
    });
    const options = unwrap(posters().paperOptions("ada-paper", { memberId: "ada", admin: false }))!;
    expect(options).toMatchObject({
      conference_key: "neurips:2026",
      conference_label: "NeurIPS 2026",
      state: "unanswered",
      printer_name: "Rahul Printer",
    });
    expect(options.sites).toHaveLength(3);
    expect(options.site_key).toBe(undefined);

    unwrap(
      service.upsertPaper({
        id: "draft",
        title: "Under review",
        authors: ["Ada Lovelace"],
        author_links: [{ name: "Ada Lovelace", member_id: "ada" }],
        current_step: "overleaf_writing",
        first_author_member_id: "ada",
      } as never),
    );
    expect(posters().paperOptions("draft", { memberId: "ada", admin: false })).toMatchObject({
      ok: true,
      payload: null,
    });
  });
});

describe("an author's answer", () => {
  it("validates the city and the size before writing anything", () => {
    const { posters } = lab();
    const ada = { memberId: "ada", admin: false };
    expect(posters().setRequest("ada-paper", { choice: "lab_print" }, ada)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      posters().setRequest("ada-paper", { choice: "lab_print", site_key: "emnlp:2026" }, ada),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      posters().setRequest(
        "ada-paper",
        { choice: "lab_print", site_key: PARIS, size: "custom" },
        ada,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      posters().setRequest("ada-paper", { choice: "lab_print", site_key: PARIS, copies: 9 }, ada),
    ).toMatchObject({ ok: false, status: 400 });
    expect(posters().setRequest("ada-paper", { choice: "self_print" }, { memberId: "bob", admin: false }))
      .toMatchObject({ ok: false, status: 403 });
    expect(unwrap(posters().paperOptions("ada-paper", ada))!.request).toBe(undefined);
  });

  it("places the paper, fills in defaults and mirrors the answer onto the checklist", () => {
    const { service, posters } = lab();
    const ada = { memberId: "ada", admin: false };
    const saved = unwrap(
      posters().setRequest("ada-paper", { choice: "lab_print", site_key: PARIS }, ada),
    )!;
    expect(saved).toMatchObject({
      site_key: PARIS,
      state: "missing_file",
      deadline_on: "2026-11-25",
      request: { size: "A0", orientation: "portrait", copies: 1 },
    });
    const slots = unwrap(service.listPaperSlots("ada-paper", { memberId: "ada" })).slots;
    expect(slots.find((slot) => slot.slot === "poster_physical")?.value_text).toBe("to_print");

    unwrap(posters().setRequest("ada-paper", { choice: "no_poster" }, ada));
    const after = unwrap(service.listPaperSlots("ada-paper", { memberId: "ada" })).slots;
    expect(after.find((slot) => slot.slot === "poster_physical")?.value_text).toBe("not_needed");
  });
});

describe("batch settings", () => {
  it("refuses a key no batch reads, a printer who is not a member, and a deadline on the defaults", () => {
    const { posters } = lab();
    expect(posters().saveBatch("neuripsparsi:2026", {}, "cy")).toMatchObject({ ok: false, status: 404 });
    expect(posters().saveBatch(PARIS, { printer_member_id: "ghost" }, "cy")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(posters().saveBatch("default", { deadline_on: "2026-11-30" }, "cy")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(posters().saveBatch("default", { lead_days: 200 }, "cy")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("lets a per-site printer take over one city", () => {
    const { posters, admin } = lab();
    unwrap(posters().saveBatch("neuripsatlanta:2026", { printer_member_id: "bob" }, "cy"));
    const views = unwrap(posters().overview(admin)).batches;
    expect(views.find((view) => view.conference_key === "neuripsatlanta:2026")?.printer?.member_id).toBe(
      "bob",
    );
    expect(views.find((view) => view.conference_key === PARIS)?.printer?.member_id).toBe("rahul");
  });
});

describe("the daily sweep", () => {
  it("files one reminder per unanswered paper, once, and withdraws it when the author answers", () => {
    const { posters, pending } = lab();
    expect(unwrap(posters().sweep())).toEqual({
      reminders_filed: 2,
      handoffs_filed: 0,
      withdrawn: 0,
      skipped_unreachable: 0,
    });
    expect(pending().map((proposal) => proposal.target?.recipientMemberId).toSorted()).toEqual([
      "ada",
      "bob",
    ]);
    expect(unwrap(posters().sweep())).toMatchObject({ reminders_filed: 0, withdrawn: 0 });
    expect(pending()).toHaveLength(2);

    unwrap(posters().setRequest("ada-paper", { choice: "self_print" }, { memberId: "ada", admin: false }));
    expect(unwrap(posters().sweep())).toMatchObject({ reminders_filed: 0, withdrawn: 1 });
    expect(pending().map((proposal) => proposal.target?.recipientMemberId)).toEqual(["bob"]);
  });

  it("skips an author AdminBot cannot DM rather than messaging someone else", () => {
    const { service, posters } = lab();
    unwrap(
      service.upsertPaper({
        id: "quiet-paper",
        title: "Quiet",
        authors: ["Quiet Person"],
        author_links: [{ name: "Quiet Person", member_id: "quiet" }],
        current_step: "overleaf_writing",
        first_author_member_id: "quiet",
        venue_decision: "accept",
        accepted_venue: "NeurIPS",
        accepted_year: 2026,
      } as never),
    );
    expect(unwrap(posters().sweep())).toMatchObject({ reminders_filed: 2, skipped_unreachable: 1 });
  });

  it("hands the printer the list on the deadline, marks the batch sent once delivered, and lets them mark it printed", async () => {
    const { service, posters, pending, clock, admin } = lab();
    const ada = { memberId: "ada", admin: false };
    unwrap(posters().setRequest("ada-paper", { choice: "lab_print", site_key: PARIS }, ada));
    unwrap(
      service.setPaperSlot({
        paperId: "ada-paper",
        slot: "poster",
        input: { url: "https://drive.example/ada.pdf" },
        memberId: "ada",
        privileged: false,
      }),
    );
    clock.now = new Date("2026-11-25T09:00:00Z");
    expect(unwrap(posters().sweep())).toMatchObject({ handoffs_filed: 1 });
    const handoff = pending().find((proposal) => proposal.target?.recipientMemberId === "rahul")!;
    expect(String((handoff.proposed_payload as { message: string }).message)).toContain("Paper ada-paper");

    unwrap(service.approve(handoff.id, { payload_hash: handoff.payload_hash, approver_id: "cy", approver_role: "admin" }));
    unwrap(await service.execute(handoff.id, { dry_run: false }));
    const paris = unwrap(posters().overview(admin)).batches.find((view) => view.conference_key === PARIS)!;
    expect(paris.status).toBe("sent");
    expect(unwrap(posters().sweep())).toMatchObject({ handoffs_filed: 0 });

    expect(posters().markPrinted(PARIS, { memberId: "bob", admin: false })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(unwrap(posters().markPrinted(PARIS, { memberId: "rahul", admin: false }))).toEqual({
      printed: ["ada-paper"],
    });
    const slots = unwrap(service.listPaperSlots("ada-paper", { memberId: "ada" })).slots;
    expect(slots.find((slot) => slot.slot === "poster_physical")?.value_text).toBe("printed");
  });
});
