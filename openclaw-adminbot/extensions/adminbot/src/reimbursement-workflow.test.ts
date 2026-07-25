import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAdminBotReimbursementWorkflow } from "./reimbursement-workflow.js";

// A stub for the real extraction script (which needs python-docx/openpyxl/poppler-utils):
// this only proves the TS side turns the extractor's declared images into image_url content
// parts, independent of whether those optional system dependencies are installed here.
function stubExtractScript(images: Array<{ media_type: string; data_base64: string }>): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adminbot-extract-stub-"));
  const script = path.join(directory, "extract-stub.py");
  writeFileSync(
    script,
    `import json, sys
print(json.dumps({"receipts": [{"name": "receipt.pdf", "text": "vendor: Example Co", "images": ${JSON.stringify(images)}}]}))
`,
  );
  return script;
}

function modelResponse(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function completeDraft() {
  return {
    assistant_message: "Both forms are ready for review.",
    claimant_name: "Ada Lovelace",
    claimant_email: "ada@example.com",
    claimant_address: "1 King Street, Toronto, ON",
    claimant_title: "Researcher",
    personnel_number: null,
    travel_period: "2026-07-08 to 2026-07-10",
    purpose: "Attend the lab workshop.",
    currency: "CAD",
    other_currency: null,
    trip_title: "Montreal lab workshop",
    trip_dates: "2026-07-08 to 2026-07-10",
    trip_location: "Montreal, QC",
    expenses: [
      {
        receipt_number: "1",
        date: "2026-07-08",
        description: "Train to Montreal",
        category: "rail",
        amount: 125.5,
        currency: "CAD",
        region: "canada",
        tax_region: "other_canada",
        airfare_class: null,
        includes_tip: null,
      },
    ],
  };
}

describe("AdminBot reimbursement workflow", () => {
  it("keeps intake on the loopback model and marks a complete draft ready", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(completeDraft()));
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: fetchImpl as typeof fetch,
      env: { ADMINBOT_LOCAL_BASE_URL: "http://127.0.0.1:8000/v1" },
    });

    const result = await workflow.converse({ message: "The trip was for our workshop." });

    expect(result.ready).toBe(true);
    expect(result.missing_fields).toEqual([]);
    expect(result.draft).not.toHaveProperty("assistant_message");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("reports missing form fields without inventing them", async () => {
    const incomplete = completeDraft();
    incomplete.claimant_email = null;
    incomplete.expenses = [];
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: vi.fn(async () => modelResponse(incomplete)) as typeof fetch,
    });

    const result = await workflow.converse({ message: "Start my reimbursement." });

    expect(result.ready).toBe(false);
    expect(result.missing_fields).toEqual(["claimant_email", "expenses"]);
  });

  it("rejects uploaded data that is not actually a PDF before model use", async () => {
    const fetchImpl = vi.fn();
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      workflow.converse({
        message: "Analyze this receipt.",
        receipts: [
          {
            name: "receipt.pdf",
            media_type: "application/pdf",
            data_base64: Buffer.from("not a pdf").toString("base64"),
          },
        ],
      }),
    ).rejects.toThrow("not a valid application/pdf file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects receipt files that are not PDF, PNG, or JPEG", async () => {
    const fetchImpl = vi.fn();
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      workflow.converse({
        message: "Analyze this receipt.",
        receipts: [
          {
            name: "receipt.gif",
            // @ts-expect-error deliberately outside the supported media type union
            media_type: "image/gif",
            data_base64: Buffer.from("GIF89a").toString("base64"),
          },
        ],
      }),
    ).rejects.toThrow("must be a PDF, PNG, or JPEG file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the model endpoint when it is not listening", async () => {
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      env: { ADMINBOT_LOCAL_BASE_URL: "http://127.0.0.1:8000/v1" },
    });

    await expect(workflow.converse({ message: "Start my reimbursement." })).rejects.toThrow(
      "the local reimbursement model at http://127.0.0.1:8000 is unreachable",
    );
  });

  it("sends rendered PDF pages to the model as image content instead of relying on OCR text alone", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(completeDraft()));
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: stubExtractScript([
        { media_type: "image/png", data_base64: "cGFnZS1vbmU=" },
        { media_type: "image/png", data_base64: "cGFnZS10d28=" },
      ]),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await workflow.converse({
      message: "Here is my receipt.",
      receipts: [
        {
          name: "receipt.pdf",
          media_type: "application/pdf",
          data_base64: Buffer.from("%PDF-1.4\nnot a real pdf body\n").toString("base64"),
        },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMessage = body.messages[1];
    expect(Array.isArray(userMessage.content)).toBe(true);
    const parts = userMessage.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toContain("vendor: Example Co");
    expect(parts.slice(1)).toEqual([
      { type: "text", text: 'Page image(s) for receipt "receipt.pdf":' },
      { type: "image_url", image_url: { url: "data:image/png;base64,cGFnZS1vbmU=" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,cGFnZS10d28=" } },
    ]);
  });

  it("labels each receipt's images so amounts aren't attributed to the wrong expense", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(completeDraft()));
    const directory = mkdtempSync(path.join(os.tmpdir(), "adminbot-extract-multi-stub-"));
    const script = path.join(directory, "extract-multi-stub.py");
    writeFileSync(
      script,
      `import json, sys
print(json.dumps({"receipts": [
  {"name": "hotel.pdf", "text": "", "images": [{"media_type": "image/png", "data_base64": "aG90ZWw="}]},
  {"name": "flight-1.pdf", "text": "", "images": [{"media_type": "image/png", "data_base64": "ZmxpZ2h0MQ=="}]}
]}))
`,
    );
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: script,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await workflow.converse({
      message: "Here are my receipts.",
      receipts: [
        {
          name: "hotel.pdf",
          media_type: "application/pdf",
          data_base64: Buffer.from("%PDF-1.4\nhotel\n").toString("base64"),
        },
        {
          name: "flight-1.pdf",
          media_type: "application/pdf",
          data_base64: Buffer.from("%PDF-1.4\nflight\n").toString("base64"),
        },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const parts = body.messages[1].content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(parts.slice(1)).toEqual([
      { type: "text", text: 'Page image(s) for receipt "hotel.pdf":' },
      { type: "image_url", image_url: { url: "data:image/png;base64,aG90ZWw=" } },
      { type: "text", text: 'Page image(s) for receipt "flight-1.pdf":' },
      { type: "image_url", image_url: { url: "data:image/png;base64,ZmxpZ2h0MQ==" } },
    ]);
  });

  it("surfaces the prior assistant turn so the model can't silently repeat itself", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(completeDraft()));
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await workflow.converse({
      message: "hi are you an LLM model",
      messages: [
        { role: "user", content: "extract the specific dates and cost from the attachments" },
        { role: "assistant", content: "Please provide the travel dates and amounts." },
      ],
      draft: { claimant_name: "Jerick Shi" },
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userParts = body.messages[1].content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(userParts[0]?.text ?? "{}") as {
      latest_message: string;
      previous_assistant_message: string | null;
    };
    expect(payload.latest_message).toBe("hi are you an LLM model");
    expect(payload.previous_assistant_message).toBe("Please provide the travel dates and amounts.");
    expect(body.messages[0].content as string).toContain("Never repeat");
  });

  it("sends an uploaded receipt photo straight to the model without going through Python", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(completeDraft()));
    const workflow = createAdminBotReimbursementWorkflow({
      // No extraction script is needed for image receipts, so pointing at a
      // nonexistent script proves the image path never shells out to Python.
      formScriptPath: "/does-not-exist.py",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const jpegBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from("fake jpeg body"),
    ]);
    await workflow.converse({
      message: "Here is a photo of my taxi receipt.",
      receipts: [
        { name: "taxi.jpg", media_type: "image/jpeg", data_base64: jpegBytes.toString("base64") },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const parts = (
      body.messages[1] as {
        content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
      }
    ).content;
    expect(parts.slice(1)).toEqual([
      { type: "text", text: 'Page image(s) for receipt "taxi.jpg":' },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${jpegBytes.toString("base64")}` },
      },
    ]);
  });

  it("keeps the HTTP status when the model returns a non-JSON error body", async () => {
    const workflow = createAdminBotReimbursementWorkflow({
      formScriptPath: "/unused.py",
      fetchImpl: vi.fn(
        async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      ) as typeof fetch,
    });

    await expect(workflow.converse({ message: "Start my reimbursement." })).rejects.toThrow(
      "local reimbursement model HTTP 502",
    );
  });
});
