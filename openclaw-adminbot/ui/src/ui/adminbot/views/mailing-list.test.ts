/* @vitest-environment jsdom */

// The Mailing List tab. The cases below are all about one risk: sending a short list and
// believing it is the whole truth.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicationDigestPreview } from "../auth/session.ts";
import { renderMailingList, type MailingListProps } from "./mailing-list.ts";

function preview(overrides: Partial<PublicationDigestPreview> = {}): PublicationDigestPreview {
  return {
    from: "2026-01-01",
    to: "2026-12-31",
    publications: [
      {
        id: "p1",
        title: "Judging the Judges",
        authors: ["Arth", "Zhijing"],
        venue: "NeurIPS 2026",
        url: "https://arxiv.org/abs/2606.00001",
        date: { iso: "2026-06-01", precision: "month", source: "arxiv" },
      },
    ],
    venues: [
      { key: "iclr 2027", label: "ICLR 2027", accepted: 1, pending: 8 },
      { key: "neurips 2026", label: "NeurIPS 2026", accepted: 2, pending: 0 },
    ],
    excluded: [{ id: "p2", title: "Undated Work", reason: "no_date" }],
    undated_count: 1,
    pending_count: 0,
    subject: "Jinesis Lab publications, 2026-01-01 to 2026-12-31",
    body: "Publications from the Jinesis Lab...",
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

// Awaited, because a Lit element's first render happens on a microtask: querying synchronously
// would assert against an empty host and pass or fail for the wrong reason.
async function draw(overrides: Partial<MailingListProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const props: MailingListProps = {
    preview: preview(),
    loading: false,
    sending: false,
    error: null,
    notice: null,
    from: "2026-01-01",
    to: "2026-12-31",
    email: "funder@example.org",
    venue: "",
    venues: preview().venues,
    onRangeChange: () => undefined,
    onVenueChange: () => undefined,
    onEmailChange: () => undefined,
    onPreview: () => undefined,
    onSend: () => undefined,
    ...overrides,
  };
  render(renderMailingList(props), container);
  await (
    container.querySelector("adminbot-mailing-list-view") as { updateComplete?: Promise<unknown> }
  )?.updateComplete;
  return container;
}

describe("renderMailingList", () => {
  it("shows what was left out as prominently as what is in", async () => {
    const container = await draw();
    const undated = container.querySelector('[data-testid="mailing-list-undated"]');
    // The lab's records carry almost no acceptance data, so this list is usually the honest
    // answer to "why is this digest so short".
    expect(undated?.textContent).toContain("Undated Work");
    expect(undated?.textContent).toContain("1 papers left out");
  });

  it("says where each date came from", async () => {
    // A month off an arXiv id and a year off accepted_year are different strengths of claim.
    expect(container_text(await draw())).toContain("arXiv");
  });

  it("refuses to send without a recipient", async () => {
    const send = await (
      await draw({ email: "" })
    ).querySelector<HTMLButtonElement>('[data-testid="mailing-list-send"]');
    expect(send?.disabled).toBe(true);
  });

  it("refuses to send before anything has been previewed", async () => {
    // The send is a second click on a preview already on screen, never a first action.
    const send = await (
      await draw({ preview: null })
    ).querySelector<HTMLButtonElement>('[data-testid="mailing-list-send"]');
    expect(send).toBeNull();
  });

  it("says plainly when a range holds nothing rather than rendering an empty list", async () => {
    const container = await draw({
      preview: preview({ publications: [], undated_count: 0, excluded: [] }),
    });
    expect(container_text(container)).toContain(
      "No publications in our records fall in this range",
    );
  });

  it("surfaces an error without hiding the controls that would fix it", async () => {
    const container = await draw({ error: "AdminBot is unreachable at http://x." });
    expect(container.querySelector('[data-testid="mailing-list-error"]')?.textContent).toContain(
      "unreachable",
    );
    // The range inputs stay, so the person can change something and retry.
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(2);
  });
});

describe("renderMailingList by venue", () => {
  const accepted: PublicationDigestPreview = preview({
    venue: "ICLR 2027",
    publications: [
      {
        id: "p1",
        title: "Judging the Judges",
        authors: ["Arth", "Zhijing"],
        venue: "ICLR 2027",
        // No date: accepted at the venue is why it is here, and an undated accepted paper is
        // still a paper the lab got in.
      },
    ],
    excluded: [{ id: "p3", title: "Aimed There Only", reason: "not_accepted" }],
    undated_count: 0,
    pending_count: 1,
  });

  it("offers each venue with what a digest for it would hold", async () => {
    const options = (await draw()).querySelectorAll('[data-testid="mailing-list-venue"] option');
    // The count is on the option itself, so choosing "ICLR 2027" has already told the admin the
    // email will be short and why.
    expect([...options].map((option) => option.textContent?.trim())).toEqual([
      "A date range",
      "ICLR 2027 — 1 accepted, 8 awaiting a decision",
      "NeurIPS 2026 — 2 accepted, 0 awaiting a decision",
    ]);
  });

  it("stops the dates mattering once a venue is chosen", async () => {
    const container = await draw({ venue: "iclr 2027", preview: accepted });
    // An acceptance list is the whole venue; leaving the dates live would suggest they still cut.
    for (const input of container.querySelectorAll<HTMLInputElement>('input[type="date"]')) {
      expect(input.disabled).toBe(true);
    }
  });

  it("keeps an accepted paper with no date, and says so rather than showing a blank", async () => {
    const container = await draw({ venue: "iclr 2027", preview: accepted });
    expect(container_text(container)).toContain("1 papers accepted at ICLR 2027");
    expect(container_text(container)).toContain("Date not recorded");
  });

  it("names the papers still awaiting a decision instead of the undated ones", async () => {
    const container = await draw({ venue: "iclr 2027", preview: accepted });
    const pending = container.querySelector('[data-testid="mailing-list-pending"]');
    // This is what explains a thin ICLR list: papers aimed there that nobody has heard back on.
    expect(pending?.textContent).toContain("Aimed There Only");
    expect(pending?.textContent).toContain("1 papers aimed at ICLR 2027");
    expect(container.querySelector('[data-testid="mailing-list-undated"]')).toBeNull();
  });

  it("says plainly when nothing was accepted there", async () => {
    const container = await draw({
      venue: "iclr 2027",
      preview: preview({ venue: "ICLR 2027", publications: [], excluded: [], undated_count: 0 }),
    });
    expect(container_text(container)).toContain(
      "No paper in our records is recorded as accepted at ICLR 2027",
    );
  });
});

function container_text(container: HTMLElement): string {
  return container.textContent ?? "";
}

// The tab's controls are the app's controls. Written as bare labels around bare inputs they drew
// browser defaults, two tabs away from the Announcements composer they are supposed to match.
describe("the controls", () => {
  it("wires the range and recipient into the shared form styling", async () => {
    const container = await draw();
    const controls = container.querySelector(".adminbot-mailing-list__controls");
    expect(controls?.classList.contains("adminbot-form")).toBe(true);
    const fields = controls?.querySelectorAll(".adminbot-form__field") ?? [];
    // Four since the venue picker joined the row: compose-from, from, to, recipient.
    expect(fields).toHaveLength(4);
    // Each field labels its own box, which is what the shared rule styles. The picker's box is a
    // select rather than an input, and the shared rule has to reach it just the same.
    for (const field of fields) {
      expect(field.querySelector("span")).not.toBeNull();
      expect(field.querySelector("input, select")).not.toBeNull();
    }
  });
});
