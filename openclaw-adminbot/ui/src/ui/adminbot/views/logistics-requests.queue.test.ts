// The admin queue: what each row shows, and the two things an admin does from it.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { LogisticsRequest, LogisticsRequestStatus } from "../auth/session.ts";
import { renderAdminBotLogisticsQueue } from "./logistics-requests.queue.ts";

type DrawOptions = {
  requests?: LogisticsRequest[];
  loading?: boolean;
  error?: string | null;
  showSettled?: boolean;
  signingId?: string | null;
  signedNote?: string;
  downloadingId?: string | null;
};

function draw(options: DrawOptions = {}) {
  const uploads: { id: string; files: File[] }[] = [];
  const statuses: { id: string; status: LogisticsRequestStatus }[] = [];
  const opened: string[] = [];
  const settledToggles: boolean[] = [];
  const noteChanges: string[] = [];
  const downloads: { id: string; name: string }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotLogisticsQueue({
      requests: options.requests ?? [],
      loading: options.loading ?? false,
      error: options.error ?? null,
      showSettled: options.showSettled ?? false,
      onShowSettledChange: (next) => settledToggles.push(next),
      signingId: options.signingId ?? null,
      downloadingId: options.downloadingId ?? null,
      onDownload: (id, name) => downloads.push({ id, name }),
      signedNote: options.signedNote ?? "",
      onSignedNoteChange: (next) => noteChanges.push(next),
      onSendSigned: (id, files) => uploads.push({ id, files }),
      onOpenRequest: (id) => opened.push(id),
      onSetStatus: (id, status) => statuses.push({ id, status }),
    }),
    container,
  );
  return { container, uploads, statuses, opened, settledToggles, noteChanges, downloads };
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
  it("puts every fact about a request on one line", () => {
    const { container } = draw({
      requests: [request({ deadline_at: "2026-12-01T23:59:00.000Z" })],
    });
    const headings = [...container.querySelectorAll(".logistics-queue__head")].map((head) =>
      head.textContent?.trim(),
    );
    expect(headings).toEqual([
      "Submitted",
      "User",
      "Type of Request",
      "Documents to sign",
      "What it is for",
      "Most Recent Deadline",
      "Status",
      "Signed Document",
    ]);
    const text = rows(container)[0]?.textContent?.replace(/\s+/gu, " ") ?? "";
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Visa letter for the Berlin trip");
    expect(text).toContain("form.pdf");
    expect(text).toContain("Dec 1, 2026");
  });

  it("hands the document over from the row, fetching it on the way", () => {
    // The whole point of this screen: take the thing that needs signing without opening a card.
    // The bytes are not in the queue -- the list read strips them -- so the press is what gets them.
    const drawn = draw({ requests: [request()] });
    const button = drawn.container.querySelector<HTMLButtonElement>(
      "[data-testid='logistics-queue-download']",
    );
    expect(button?.textContent).toContain("form.pdf");
    button?.click();
    expect(drawn.downloads).toEqual([{ id: "logreq_1", name: "form.pdf" }]);
  });

  it("does not offer the same file twice while it is being fetched", () => {
    const { container } = draw({ requests: [request()], downloadingId: "logreq_1:form.pdf" });
    expect(
      container.querySelector<HTMLButtonElement>("[data-testid='logistics-queue-download']")
        ?.disabled,
    ).toBe(true);
  });

  it("shows the name alone once the service has dropped the bytes", () => {
    const { container } = draw({
      showSettled: true,
      requests: [
        request({
          status: "completed",
          documents: [{ name: "form.pdf", size: 2048 }],
          files_cleared_at: "2026-08-20T10:00:00.000Z",
        }),
      ],
    });
    expect(container.querySelector("[data-testid='logistics-queue-download']")).toBeNull();
    expect(container.querySelector(".logistics-queue__file")?.textContent).toContain("form.pdf");
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

  it("reports a failure to read the queue", () => {
    const { container } = draw({ requests: [], error: "Could not reach the AdminBot service." });
    expect(container.querySelector(".logistics-requests__error")?.textContent).toContain(
      "Could not reach",
    );
  });
});
