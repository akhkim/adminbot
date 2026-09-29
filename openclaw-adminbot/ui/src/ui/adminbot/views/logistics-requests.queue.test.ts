// The admin queue: what each row shows, and the two things an admin does from it.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { LogisticsRequest, LogisticsRequestStatus } from "../auth/session.ts";
import {
  DEFAULT_LOGISTICS_QUEUE_OPTIONS,
  type LogisticsQueueOptions,
} from "../data/logistics-queue.ts";
import { renderAdminBotLogisticsQueue } from "./logistics-requests.queue.ts";

type DrawOptions = {
  options?: Partial<LogisticsQueueOptions>;
  requests?: LogisticsRequest[];
  loading?: boolean;
  error?: string | null;
  showSettled?: boolean;
  signingId?: string | null;
  signedNote?: string;
};

function draw(options: DrawOptions = {}) {
  const optionChanges: Partial<LogisticsQueueOptions>[] = [];
  const uploads: { id: string; files: File[] }[] = [];
  const statuses: { id: string; status: LogisticsRequestStatus }[] = [];
  const opened: string[] = [];
  const settledToggles: boolean[] = [];
  const noteChanges: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotLogisticsQueue({
      options: { ...DEFAULT_LOGISTICS_QUEUE_OPTIONS, ...options.options },
      onOptionsChange: (patch) => optionChanges.push(patch),
      requests: options.requests ?? [],
      loading: options.loading ?? false,
      error: options.error ?? null,
      showSettled: options.showSettled ?? false,
      onShowSettledChange: (next) => settledToggles.push(next),
      signingId: options.signingId ?? null,
      signedNote: options.signedNote ?? "",
      onSignedNoteChange: (next) => noteChanges.push(next),
      onSendSigned: (id, files) => uploads.push({ id, files }),
      onOpenRequest: (id) => opened.push(id),
      onSetStatus: (id, status) => statuses.push({ id, status }),
    }),
    container,
  );
  return { container, optionChanges, uploads, statuses, opened, settledToggles, noteChanges };
}

function request(fields: Partial<LogisticsRequest> = {}): LogisticsRequest {
  return {
    id: "logreq_1",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:00:00.000Z",
    description: "Visa letter for the Berlin trip",
    documents: [{ name: "form.pdf", size: 2048, data_base64: "aGVsbG8=" }],
    ...fields,
  };
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".logistics-queue__row")];
}

describe("the queue as a spreadsheet", () => {
  it("keeps the queue compact with details available from the member name", () => {
    const { container } = draw({
      requests: [request({ deadline_at: "2026-12-01T23:59:00.000Z" })],
    });
    const headings = [...container.querySelectorAll(".logistics-queue__head")].map(
      (head) =>
        head.querySelector("button")?.getAttribute("aria-label") ?? head.textContent?.trim(),
    );
    expect(headings).toEqual([
      "Submitted",
      "User",
      "Earliest deadline",
      "Status",
      "Signed Document",
    ]);
    const text = rows(container)[0]?.textContent?.replace(/\s+/gu, " ") ?? "";
    expect(rows(container)[0]?.querySelectorAll("td")).toHaveLength(5);
    expect(text).not.toContain("Document Signature");
    expect(text).toContain("Ada Lovelace");
    expect(text).not.toContain("Visa letter for the Berlin trip");
    expect(text).not.toContain("form.pdf");
    expect(text).toContain("No deadline");
  });

  it("sends the signed file as soon as it is picked", () => {
    const drawn = draw({ requests: [request()] });
    const input = drawn.container.querySelector<HTMLInputElement>(
      "[data-testid='logistics-queue-upload']",
    );
    const file = new File(["signed"], "form-signed.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.uploads).toHaveLength(1);
    expect(drawn.uploads[0]?.id).toBe("logreq_1");
    expect(drawn.uploads[0]?.files[0]?.name).toBe("form-signed.pdf");
  });

  it("blocks a second upload on the row already sending", () => {
    const { container } = draw({ requests: [request()], signingId: "logreq_1" });
    const input = container.querySelector<HTMLInputElement>(
      "[data-testid='logistics-queue-upload']",
    );
    expect(input?.disabled).toBe(true);
    expect(container.querySelector(".logistics-queue__upload")?.textContent).toContain("Sending…");
  });

  it("says where the signed document went, instead of offering to send it twice", () => {
    const { container } = draw({
      showSettled: true,
      requests: [
        request({
          status: "completed",
          signed_sent_at: "2026-08-20T10:00:00.000Z",
          signed_sent_to: "ada@cs.toronto.edu",
        }),
      ],
    });
    expect(container.querySelector(".logistics-queue__sent")?.textContent).toContain(
      "ada@cs.toronto.edu",
    );
    expect(container.querySelector("[data-testid='logistics-queue-upload']")).toBeNull();
  });

  it("offers no upload on a request that is not for a signature", () => {
    const { container } = draw({
      requests: [request({ kind: "book_meeting", documents: [] })],
    });
    expect(container.querySelector("[data-testid='logistics-queue-upload']")).toBeNull();
  });

  it("changes a status from the row, and never offers to withdraw on the member's behalf", () => {
    const drawn = draw({ requests: [request()] });
    const select = drawn.container.querySelector<HTMLSelectElement>(".logistics-queue__status");
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      "submitted",
      "in_progress",
      "completed",
      "declined",
    ]);
    select!.value = "in_progress";
    select?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.statuses).toEqual([{ id: "logreq_1", status: "in_progress" }]);
  });

  it("still names the status of a request the member withdrew", () => {
    const { container } = draw({
      showSettled: true,
      requests: [request({ status: "withdrawn" })],
    });
    const select = container.querySelector<HTMLSelectElement>(".logistics-queue__status");
    expect([...(select?.options ?? [])].map((option) => option.value)).toContain("withdrawn");
  });

  it("shows what is outstanding, and hides the rest until asked", () => {
    const requests = [
      request({ id: "open" }),
      request({ id: "done", status: "completed" }),
      request({ id: "gone", status: "withdrawn" }),
    ];
    const outstanding = draw({ requests });
    expect(rows(outstanding.container)).toHaveLength(1);
    expect(rows(outstanding.container)[0]?.dataset.status).toBe("submitted");

    const everything = draw({ requests, showSettled: true });
    expect(rows(everything.container)).toHaveLength(3);
  });

  it("asks to see the finished ones when the toggle is used", () => {
    const drawn = draw({ requests: [request()] });
    const toggle = drawn.container.querySelector<HTMLInputElement>(
      ".logistics-queue__toggle input",
    );
    toggle!.checked = true;
    toggle?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.settledToggles).toEqual([true]);
  });

  it("says the queue is clear rather than showing a bare header", () => {
    const { container } = draw({ requests: [request({ status: "completed" })] });
    expect(container.querySelector(".logistics-queue__table")).toBeNull();
    expect(container.querySelector(".logistics-requests__empty")?.textContent).toContain(
      "Nothing outstanding",
    );
  });

  it("carries the admin's note to whatever is signed next", () => {
    const drawn = draw({ requests: [request()], signedNote: "Signed all three pages." });
    const note = drawn.container.querySelector<HTMLInputElement>(".logistics-queue__note input");
    expect(note?.value).toBe("Signed all three pages.");
    note!.value = "Second page needs your supervisor.";
    note?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(drawn.noteChanges).toEqual(["Second page needs your supervisor."]);
  });

  it("opens one request in full from its member name", () => {
    const drawn = draw({ requests: [request()] });
    drawn.container.querySelector<HTMLButtonElement>(".logistics-requests__open")?.click();
    expect(drawn.opened).toEqual(["logreq_1"]);
  });

  // The status names what the recommender still has to do, not what the member already did. A
  // letter request sitting at `submitted` is a letter nobody has sent yet, so offering "Submitted"
  // as its current state is the one reading that is never true. See logistics-status.ts.
  it("names a letter request's statuses from the recommender's side", () => {
    const { container } = draw({
      requests: [request({ kind: "recommendation_letters", status: "submitted" })],
    });
    const select = container.querySelector<HTMLSelectElement>(".logistics-queue__status");
    expect(
      [...(select?.options ?? [])].map((option) => [option.value, option.textContent?.trim()]),
    ).toEqual([
      ["submitted", "To submit"],
      ["in_progress", "In progress"],
      ["completed", "Submitted"],
      ["declined", "Declined"],
    ]);
    expect(select?.value).toBe("submitted");
  });

  it("leaves the other two kinds saying what they always said", () => {
    for (const kind of ["document_signature", "book_meeting"] as const) {
      const { container } = draw({ requests: [request({ kind, status: "submitted" })] });
      const select = container.querySelector<HTMLSelectElement>(".logistics-queue__status");
      expect([...(select?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
        "Submitted",
        "In progress",
        "Done",
        "Declined",
      ]);
    }
  });

  it("reports a failure to read the queue", () => {
    const { container } = draw({ requests: [], error: "Could not reach the AdminBot service." });
    expect(container.querySelector(".logistics-requests__error")?.textContent).toContain(
      "Could not reach",
    );
  });
});

it("offers accessible sorting and filter controls while keeping the three removed columns hidden", () => {
  const drawn = draw({ requests: [request()] });
  const deadline = drawn.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Earliest deadline"]',
  )!;
  expect(deadline.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  deadline.click();
  expect(drawn.optionChanges.pop()).toEqual({ sortBy: "deadline", sortDirection: "desc" });
  const search = drawn.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "Ada";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  expect(drawn.optionChanges.pop()).toEqual({ search: "Ada" });
  const filters = drawn.container.querySelectorAll<HTMLSelectElement>(
    ".logistics-queue__filters select",
  );
  filters[0].value = "recommendation_letters";
  filters[0].dispatchEvent(new Event("change", { bubbles: true }));
  expect(drawn.optionChanges.pop()).toEqual({ kind: "recommendation_letters" });
  filters[1].value = "completed";
  filters[1].dispatchEvent(new Event("change", { bubbles: true }));
  expect(drawn.optionChanges.pop()).toEqual({ status: "completed" });
  expect(drawn.settledToggles).toEqual([]);
});

it("distinguishes no filter matches from an empty queue", () => {
  const drawn = draw({ requests: [request()], options: { search: "nobody" } });
  expect(drawn.container.textContent).toContain("No requests match these filters.");
  expect(drawn.container.querySelector('input[type="search"]')).not.toBeNull();
});
