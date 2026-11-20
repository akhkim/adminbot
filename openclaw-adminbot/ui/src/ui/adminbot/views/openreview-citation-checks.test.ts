import { afterEach, beforeEach, expect, it, vi } from "vitest";

const authedJson = vi.fn();
const peekAuthedRead = vi.fn();
vi.mock("../auth/session.ts", () => ({
  authedJson: (...args: unknown[]) => authedJson(...args),
  peekAuthedRead: (...args: unknown[]) => peekAuthedRead(...args),
}));

const { OpenReviewCitationChecks } = await import("./openreview-citation-checks.ts");

beforeEach(() => {
  authedJson.mockReset();
  peekAuthedRead.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(response: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
  const body = response.json ? await response.json() : {};
  const fetcher = authedJson.mockResolvedValue({
    response: { ok: response.ok, status: response.status },
    body,
  });
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

// Every version with every reference: what a service older than the summary view still sends.
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
  expect(fetcher).toHaveBeenCalledWith(
    "http://localhost:8765",
    "/openreview/citation-checks?view=summary",
    "GET",
    "synthetic-admin",
  );
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

it("reads the reference and version totals from a summary row", async () => {
  const { el, text } = await mount({
    ok: true,
    status: 200,
    json: async () => ({
      enabled: true,
      running: false,
      checks: [
        { ...check, findings: [check.findings[1]], finding_count: 40, version_count: 3 },
        {
          ...check,
          submission_id: "paperBBBB",
          title: "Synthetic clean paper",
          findings: [],
          finding_count: 25,
          version_count: 1,
        },
      ],
    }),
  });
  const articles = [...el.shadowRoot!.querySelectorAll("article")];
  expect(articles.map((article) => article.dataset.state)).toEqual(["flagged", "clean"]);
  expect(text()).toContain("3 versions checked");
  expect(text()).toContain("1 not found · 0 to check · 40 references");
  expect(text()).toContain("All 25 references matched");
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

it("lists counts only and reads a paper's flagged references when its row is opened", async () => {
  const { el, fetcher, text } = await mount({
    ok: true,
    status: 200,
    json: async () => ({
      enabled: true,
      running: false,
      checks: [
        {
          ...check,
          findings: undefined,
          finding_count: 40,
          flagged_count: 2,
          not_found_count: 1,
          version_count: 1,
        },
      ],
    }),
  });
  expect(text()).toContain("1 not found · 1 to check · 40 references");
  expect(text()).not.toContain("Synthetic B. Invented. 2031.");
  fetcher.mockResolvedValueOnce({
    response: { ok: true, status: 200 },
    body: { submission_id: "paperAAAA", findings: [check.findings[1]] },
  });
  const details = el.shadowRoot!.querySelector("details")!;
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await vi.waitFor(() => expect(text()).toContain("Synthetic B. Invented. 2031."));
  expect(fetcher).toHaveBeenLastCalledWith(
    "http://localhost:8765",
    "/openreview/citation-checks?view=findings&submission_id=paperAAAA",
    "GET",
    "synthetic-admin",
  );
});

it("draws the last summary this session read before the request answers", async () => {
  peekAuthedRead.mockReturnValue({
    enabled: true,
    running: false,
    checks: [{ ...check, findings: [], finding_count: 3, version_count: 1 }],
  });
  authedJson.mockReturnValue(new Promise(() => undefined));
  const el = new OpenReviewCitationChecks();
  el.baseUrl = "http://localhost:8765/";
  el.sessionToken = "synthetic-admin";
  document.body.append(el);
  await el.updateComplete;
  await el.updateComplete;
  expect(el.shadowRoot!.textContent).toContain("All 3 references matched");
});
