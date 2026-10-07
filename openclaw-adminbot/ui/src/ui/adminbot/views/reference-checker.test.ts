import { afterEach, expect, it, vi } from "vitest";
import { canAccessTab } from "../access.ts";
import { ReferenceChecker } from "./reference-checker.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  const el = new ReferenceChecker();
  el.baseUrl = "http://localhost:8765";
  el.sessionToken = "synthetic-admin";
  document.body.append(el);
  await el.updateComplete;
  return el;
}

async function choose(el: ReferenceChecker, files: File[]) {
  const input = el.shadowRoot!.querySelector("input")!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
  await el.updateComplete;
}

it("restricts the tab to admins and rejects non-PDF selections and multiple drops", async () => {
  expect(canAccessTab("adminbotReferenceChecker", "admin")).toBe(true);
  expect(canAccessTab("adminbotReferenceChecker", "member")).toBe(false);
  expect(canAccessTab("adminbotReferenceChecker", "anonymous")).toBe(false);
  const el = await mount();
  await choose(el, [new File(["text"], "notes.txt", { type: "text/plain" })]);
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
  expect(el.shadowRoot!.textContent).toContain("Choose one PDF");
  const event = new Event("drop", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [new File(["x"], "a.pdf"), new File(["x"], "b.pdf")] },
  });
  el.shadowRoot!.querySelector(".drop")!.dispatchEvent(event);
  await el.updateComplete;
  expect(event.defaultPrevented).toBe(true);
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
});

it("uploads a dropped PDF only on Submit, renders findings, and permits repeat scans", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      findings: [
        { citation: "Synthetic citation", status: "not_found", explanation: "Not located" },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  const pdf = new File(["%PDF-synthetic"], "paper.pdf", { type: "application/pdf" });
  const drop = new Event("drop", { cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [pdf] } });
  el.shadowRoot!.querySelector(".drop")!.dispatchEvent(drop);
  await el.updateComplete;
  expect(fetcher).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) {
    el.shadowRoot!.querySelector("button")!.click();
    await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("Synthetic citation"));
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]).toEqual([
    "http://localhost:8765/reference-check/pdf?checker=references-validation&consent=query-reference-databases",
    expect.objectContaining({
      body: pdf,
      headers: {
        Authorization: "Bearer synthetic-admin",
        "Content-Type": "application/pdf",
        Accept: "application/x-ndjson",
      },
    }),
  ]);
  el.sessionToken = "";
  await el.updateComplete;
  expect(el.shadowRoot!.textContent).not.toContain("Synthetic citation");
});

it("shows errors and clears previous results when choosing another file", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "The reference check is unavailable." } }),
    }),
  );
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  await vi.waitFor(() =>
    expect(el.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain(
      "The reference check is unavailable.",
    ),
  );
  await choose(el, [new File(["%PDF-synthetic"], "next.pdf")]);
  expect(el.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
});

it("disables duplicate submissions while running and distinguishes empty results", async () => {
  let finish!: (value: unknown) => void;
  const fetcher = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  await el.updateComplete;
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
  expect(el.shadowRoot!.querySelector('[role="status"]')).not.toBeNull();
  expect(el.shadowRoot!.querySelector("select")!.disabled).toBe(true);
  el.shadowRoot!.querySelector("button")!.click();
  expect(fetcher).toHaveBeenCalledOnce();
  finish({ ok: true, json: async () => ({ citation_count: 0, uncertain_count: 0, findings: [] }) });
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("could not be assessed"));
  expect(el.shadowRoot!.textContent).not.toContain("No citations were flagged");
});

it("switches checkers without uploading, retains the PDF and renders GPTZero counts", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ citation_count: 4, uncertain_count: 1, findings: [] }),
  });
  vi.stubGlobal("fetch", fetcher);
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  const selector = el.shadowRoot!.querySelector("select")!;
  expect(selector.value).toBe("references-validation");
  selector.value = "gptzero";
  selector.dispatchEvent(new Event("change"));
  await el.updateComplete;
  expect(fetcher).not.toHaveBeenCalled();
  expect(el.shadowRoot!.textContent).toContain("uploads the full PDF");
  expect(el.shadowRoot!.textContent).toContain("403 access denied");
  expect(el.shadowRoot!.textContent).toContain("paper.pdf");
  el.shadowRoot!.querySelector("button")!.click();
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("4 citations assessed"));
  expect(el.shadowRoot!.textContent).toContain("No citations were flagged");
  expect(el.shadowRoot!.textContent).not.toContain("could not be assessed");
  expect(fetcher.mock.calls[0][0]).toBe(
    "http://localhost:8765/reference-check/pdf?checker=gptzero&consent=upload-to-gptzero",
  );
  selector.value = "references-validation";
  selector.dispatchEvent(new Event("change"));
  await el.updateComplete;
  expect(el.shadowRoot!.querySelector(".results")).toBeNull();
  expect(el.shadowRoot!.textContent).toContain("paper.pdf");
  expect(el.shadowRoot!.textContent).not.toContain("uploads the full PDF");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("renders streamed findings before completion, handles split chunks and links to Scholar", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })),
  );
  const el = await mount();
  expect(el.shadowRoot!.querySelector("select")!.textContent).toContain("CheckIfExist");
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
  controller.enqueue(encode({ type: "progress", completed: 0, total: 2 }));
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("0 of 2 references checked"));
  expect(el.shadowRoot!.textContent).not.toContain("could not be assessed");
  const finding = {
    citation: "Lovelace & Turing — synthetic citation",
    status: "not_found",
    explanation: "No matching reference found in the available databases.",
  };
  const chunk = encode({ type: "progress", completed: 1, total: 2, finding });
  const split = chunk.indexOf(0xe2) + 1;
  controller.enqueue(chunk.slice(0, split));
  controller.enqueue(chunk.slice(split));
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain(finding.citation));
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(true);
  const link = el.shadowRoot!.querySelector<HTMLAnchorElement>(".scholar")!;
  expect(link.textContent).toBe("Search Google Scholar");
  expect(new URL(link.href).searchParams.get("q")).toBe(finding.citation);
  controller.enqueue(encode({ type: "complete", result: { findings: [finding] } }));
  controller.close();
  await vi.waitFor(() => expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(false));
});

it.each(["disconnect", "error"])("preserves partial results after a stream %s", async (ending) => {
  const finding = { citation: "Partial result", status: "matched", explanation: "Found" };
  const events = [
    { type: "progress", total: 2, completed: 1, finding },
    ...(ending === "error" ? [{ type: "error", error: { message: "The check timed out." } }] : []),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(events.map((event) => JSON.stringify(event) + "\n").join(""), {
          headers: { "Content-Type": "application/x-ndjson" },
        }),
    ),
  );
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  await vi.waitFor(() => expect(el.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull());
  expect(el.shadowRoot!.textContent).toContain("Partial result");
  expect(el.shadowRoot!.querySelector(".scholar")).toBeNull();
  expect(el.shadowRoot!.querySelector("button")!.disabled).toBe(false);
});

it("offers Scholar only for not-found citations and database links for existing matches", async () => {
  const statuses = ["not_found", "matched", "review", "unavailable"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        findings: statuses.map((status) => ({
          status,
          citation: status,
          explanation: "Synthetic result",
          ...(status !== "unavailable" ? { url: "https://doi.org/10.1234/synthetic" } : {}),
        })),
      }),
    })),
  );
  const el = await mount();
  await choose(el, [new File(["%PDF-synthetic"], "paper.pdf")]);
  el.shadowRoot!.querySelector("button")!.click();
  await vi.waitFor(() => expect(el.shadowRoot!.querySelectorAll("article")).toHaveLength(4));
  for (const status of statuses) {
    const card = el.shadowRoot!.querySelector(`article[data-status="${status}"]`)!;
    expect(Boolean(card.querySelector(".scholar"))).toBe(status === "not_found");
    expect(Boolean(card.querySelector(".database"))).toBe(
      status === "matched" || status === "review",
    );
  }
});
