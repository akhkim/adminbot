import { afterEach, expect, it, vi } from "vitest";
import { tabFromPath } from "../../navigation.ts";
import { canAccessTab } from "../access.ts";
import { PaperMentorView } from "./papermentor.ts";
import type { ReferenceChecker } from "./reference-checker.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const REVIEW = {
  id: "pm_0123456789abcdef",
  label: "Synthetic Paper",
  venue: "iclr_2026",
  status: "reviewed",
  created_at: "2026-11-10T12:00:00.000Z",
  comments: 3,
  by_severity: { critical: 1, warning: 2 },
  pdf: true,
  files: ["commented_zip", "reviewed_pdf", "report"],
  downloads: [
    { kind: "commented_zip", filename: "Synthetic-Paper.papermentor.zip" },
    { kind: "reviewed_pdf", filename: "Synthetic-Paper.reviewed.pdf" },
    { kind: "report", filename: "Synthetic-Paper.review.md" },
  ],
};

function json(body: unknown, ok = true) {
  return { ok, json: async () => body, headers: new Headers() };
}

function server(overview: Record<string, unknown>) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (init?.method === "POST") {
      return json({ review: { ...REVIEW, status: "queued", files: [], downloads: [] } });
    }
    return json(overview);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

async function mount() {
  const el = new PaperMentorView();
  el.baseUrl = "http://localhost:8765";
  el.sessionToken = "synthetic-member";
  document.body.append(el);
  await el.updateComplete;
  return el;
}

function button(el: PaperMentorView, text: string) {
  return [...el.shadowRoot!.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
}

it("is a full-member tab", () => {
  expect(canAccessTab("adminbotPaperMentor", "member", "member")).toBe(true);
  expect(canAccessTab("adminbotPaperMentor", "admin", "admin")).toBe(true);
  expect(canAccessTab("adminbotPaperMentor", "member", "trial")).toBe(false);
  expect(canAccessTab("adminbotPaperMentor", "member", "external_collaborator")).toBe(false);
  expect(canAccessTab("adminbotPaperMentor", "anonymous")).toBe(false);
});

it("says so when PaperMentor is not set up, and still lists reviews", async () => {
  server({
    enabled: false,
    model_provider: null,
    venues: [],
    max_zip_bytes: null,
    checks_references: false,
    reference_checkers: ["references-validation"],
    reviews: [REVIEW],
  });
  const el = await mount();
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("not set up"));
  expect(el.shadowRoot!.querySelector("input[type='file']")).toBeNull();
  expect(el.shadowRoot!.textContent).toContain("Synthetic Paper");
  expect(el.shadowRoot!.textContent).toContain("3 comments · 1 critical · 2 warnings");
  // The PDF-only reference check works without PaperMentor installed.
  expect(el.shadowRoot!.querySelector("adminbot-reference-checker")).not.toBeNull();
});

it("uploads the zip as-is only after consent, naming the model provider", async () => {
  const { calls } = server({
    enabled: true,
    model_provider: "OpenRouter",
    venues: ["arxiv", "iclr_2026"],
    max_zip_bytes: 1024,
    checks_references: true,
    reference_checkers: ["references-validation"],
    reviews: [],
  });
  const el = await mount();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.querySelector("select option[value='iclr_2026']")).not.toBeNull(),
  );
  const root = el.shadowRoot!;
  const input = root.querySelector<HTMLInputElement>("input[type='file']")!;
  const choose = (file: File) => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    return el.updateComplete;
  };

  await choose(new File(["%PDF"], "paper.pdf", { type: "application/pdf" }));
  expect(root.querySelector("[role='alert']")?.textContent).toContain("Choose one .zip file");
  await choose(new File([new Uint8Array(2048)], "big.zip", { type: "application/zip" }));
  expect(root.querySelector("[role='alert']")?.textContent).toContain("0 MB or smaller");
  const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "My Paper.zip", {
    type: "application/zip",
  });
  await choose(zip);
  expect(root.textContent).toContain("My Paper.zip");

  const venue = root.querySelector("select")!;
  venue.value = "iclr_2026";
  venue.dispatchEvent(new Event("change"));
  const submit = button(el, "Run PaperMentor");
  expect(submit.disabled).toBe(true);
  expect(root.textContent).toContain("Send the draft's text to OpenRouter");
  const consent = root.querySelector<HTMLInputElement>("input[type='checkbox']")!;
  consent.checked = true;
  consent.dispatchEvent(new Event("change"));
  await el.updateComplete;
  expect(submit.disabled).toBe(false);
  submit.click();
  await vi.waitFor(() => expect(root.textContent).toContain("PaperMentor is on it"));

  const [url, init] = calls.find(([, i]) => i?.method === "POST")!;
  const sent = new URL(url);
  expect(`${sent.origin}${sent.pathname}`).toBe("http://localhost:8765/papermentor/reviews");
  // The reference check is on by default, and the box is the member's consent to it.
  expect(Object.fromEntries(sent.searchParams)).toEqual({
    consent: "send-draft-to-model-provider",
    filename: "My Paper",
    venue: "iclr_2026",
    check_references: "1",
    references_consent: "query-reference-databases",
  });
  expect(init!.body).toBe(zip);
  expect(init!.headers).toMatchObject({
    Authorization: "Bearer synthetic-member",
    "Content-Type": "application/zip",
  });
});

it("downloads the post-review zip under the name the service gave it", async () => {
  const { fetcher } = server({
    enabled: true,
    model_provider: "OpenRouter",
    venues: [],
    max_zip_bytes: null,
    checks_references: true,
    reference_checkers: ["references-validation"],
    reviews: [REVIEW],
  });
  const el = await mount();
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("Download reviewed zip"));
  expect(el.shadowRoot!.textContent).toContain("Annotated PDF");
  const blob = new Blob(["PK"], { type: "application/zip" });
  fetcher.mockImplementationOnce(async () => ({
    ok: true,
    blob: async () => blob,
    headers: new Headers(),
  }));
  const created = vi.fn(() => "blob:synthetic");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
  const names: string[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  button(el, "Download reviewed zip").click();
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith(blob));
  expect(names).toEqual(["Synthetic-Paper.papermentor.zip"]);
  expect(fetcher).toHaveBeenLastCalledWith(
    "http://localhost:8765/papermentor/reviews/pm_0123456789abcdef/files/commented_zip",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-member" }),
    }),
  );
  click.mockRestore();
});

it("leaves the references out when the member unticks the check", async () => {
  const { calls } = server({
    enabled: true,
    model_provider: "OpenRouter",
    venues: [],
    max_zip_bytes: null,
    checks_references: true,
    reference_checkers: ["references-validation"],
    reviews: [],
  });
  const el = await mount();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.querySelector("input[name='check-references']")).not.toBeNull(),
  );
  const root = el.shadowRoot!;
  const input = root.querySelector<HTMLInputElement>("input[type='file']")!;
  Object.defineProperty(input, "files", {
    value: [new File([new Uint8Array([0x50, 0x4b, 3, 4])], "p.zip")],
    configurable: true,
  });
  input.dispatchEvent(new Event("change"));
  for (const selector of ["input[name='check-references']", "input[type='checkbox']"]) {
    const box = root.querySelector<HTMLInputElement>(selector)!;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  }
  await el.updateComplete;
  button(el, "Run PaperMentor").click();
  await vi.waitFor(() => expect(calls.some(([, i]) => i?.method === "POST")).toBe(true));
  const [url] = calls.find(([, i]) => i?.method === "POST")!;
  expect(new URL(url).searchParams.has("check_references")).toBe(false);
  expect(new URL(url).searchParams.has("references_consent")).toBe(false);
});

it("shows a review's reference check in place, and hands the PDF check the service's checkers", async () => {
  const checked = {
    ...REVIEW,
    files: [...REVIEW.files, "references"],
    downloads: [
      ...REVIEW.downloads,
      { kind: "references", filename: "Synthetic-Paper.references.json" },
    ],
    references: {
      status: "checked",
      source: "bib",
      total: 2,
      matched: 1,
      needs_review: 0,
      not_found: 1,
      unavailable: 0,
    },
  };
  const { fetcher } = server({
    enabled: true,
    model_provider: "OpenRouter",
    venues: [],
    max_zip_bytes: null,
    checks_references: true,
    reference_checkers: ["references-validation", "gptzero"],
    reviews: [checked],
  });
  const el = await mount();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.textContent).toContain("2 references checked (from the paper's .bib)"),
  );
  const root = el.shadowRoot!;
  expect(root.textContent).toContain("1 not found");
  expect(root.textContent).not.toContain("Reference check (.json)");
  const embedded = root.querySelector("adminbot-reference-checker") as ReferenceChecker;
  expect(embedded.checkers).toEqual(["references-validation", "gptzero"]);

  fetcher.mockImplementationOnce(async () =>
    json({
      source: "bib",
      findings: [
        { citation: "Synthetic Citation One", status: "not_found", explanation: "No match." },
        { citation: "Synthetic Citation Two", status: "matched", explanation: "Found." },
      ],
    }),
  );
  button(el, "Show reference check").click();
  await vi.waitFor(() => expect(root.querySelectorAll(".findings article")).toHaveLength(2));
  expect(fetcher).toHaveBeenLastCalledWith(
    "http://localhost:8765/papermentor/reviews/pm_0123456789abcdef/files/references",
    expect.anything(),
  );
  expect(root.querySelector(".findings .scholar")).not.toBeNull();
  button(el, "Hide reference check").click();
  await el.updateComplete;
  expect(root.querySelector(".findings")).toBeNull();
});

it("keeps the old Reference Checker links working", () => {
  expect(tabFromPath("/reference-checker")).toBe("adminbotPaperMentor");
});
