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
    excluded: [{ id: "p2", title: "Undated Work", reason: "no_date" }],
    undated_count: 1,
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
    onRangeChange: () => undefined,
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
    expect(fields).toHaveLength(3);
    // Each field labels its own box, which is what the shared rule styles.
    for (const field of fields) {
      expect(field.querySelector("span")).not.toBeNull();
      expect(field.querySelector("input")).not.toBeNull();
    }
  });
});
