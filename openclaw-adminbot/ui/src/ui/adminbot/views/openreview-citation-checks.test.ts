import { afterEach, expect, it, vi } from "vitest";
import { OpenReviewCitationChecks } from "./openreview-citation-checks.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(response: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  const el = new OpenReviewCitationChecks();
  el.baseUrl = "http://localhost:8765/";
  el.sessionToken = "synthetic-admin";
  document.body.append(el);
  await el.updateComplete;
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
  await el.updateComplete;
  return { el, fetcher, text: () => el.shadowRoot!.textContent ?? "" };
}

const check = {
  submission_id: "paperAAAA",
  pdf_path: "/pdf/v2.pdf",
  title: "Synthetic flagged paper",
  venue_id: "Synthetic.cc/2027/Conference/Submission",
  status: "completed",
  checked_at: "2026-09-23T12:00:00.000Z",
  attempts: 1,
  notification_proposal_id: "proposal-1",
  findings: [
    { citation: "Synthetic A. Real. 2024.", status: "matched", explanation: "Found." },
    { citation: "Synthetic B. Invented. 2031.", status: "not_found", explanation: "Missing." },
  ],
};

it("shows each submission's latest version and its flagged references", async () => {
  const { el, fetcher, text } = await mount({
    ok: true,
    status: 200,
    json: async () => ({
      enabled: true,
      running: false,
      last_sweep: { started_at: "2026-09-23T12:00:00.000Z", checked: 1, flagged: 1, failed: 0 },
      checks: [
        check,
        { ...check, pdf_path: "/pdf/v1.pdf", checked_at: "2026-09-20T12:00:00.000Z" },
        {
          ...check,
          submission_id: "paperBBBB",
          title: "Synthetic clean paper",
          notification_proposal_id: undefined,
          findings: [check.findings[0]],
        },
      ],
    }),
  });
  expect(fetcher).toHaveBeenCalledWith("http://localhost:8765/openreview/citation-checks", {
    headers: { Authorization: "Bearer synthetic-admin" },
  });
  const articles = [...el.shadowRoot!.querySelectorAll("article")];
  expect(articles.map((article) => article.dataset.state)).toEqual(["flagged", "clean"]);
  expect(text()).toContain("2 versions checked");
  expect(text()).toContain("1 not found");
  expect(text()).toContain("Pending Actions");
  expect(text()).toContain("Synthetic B. Invented. 2031.");
  expect(text()).not.toContain("Synthetic A. Real. 2024.");
  expect(text()).toContain("All 1 references matched");
  const forum = articles[0].querySelector("h3 a")!;
  expect(forum.getAttribute("href")).toBe("https://openreview.net/forum?id=paperAAAA");
});

it("says so when the deployment has not enabled automatic checks", async () => {
  const { text } = await mount({
    ok: true,
    status: 200,
    json: async () => ({ enabled: false, running: false, checks: [] }),
  });
  expect(text()).toContain("Automatic checks are off");
});

it("renders nothing for a session the server refuses", async () => {
  const { el } = await mount({ ok: false, status: 403 });
  expect(el.shadowRoot!.querySelector("section")).toBeNull();
});
