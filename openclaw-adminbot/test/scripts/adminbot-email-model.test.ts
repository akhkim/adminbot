import { describe, expect, it, vi } from "vitest";
import { AdminBotEmailModel, gmailOneHourQuery } from "../../scripts/adminbot-email-model.js";

describe("AdminBot email model", () => {
  it("queries an exact one-hour Gmail epoch window", () => {
    expect(gmailOneHourQuery(new Date("2026-07-18T12:00:00Z"))).toBe(
      "in:inbox after:1784372400 before:1784376001 -from:jinesis.adminbot@gmail.com",
    );
  });

  it("uses loopback Ollama with Gemma 4 and a constrained JSON schema", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              category: "student_reachout",
              confidence: 0.97,
              reason: "prospective student requests a research opportunity",
              decision: null,
              candidateEmail: null,
              candidateName: "Genis",
            }),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const model = new AdminBotEmailModel(fetchMock, {
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      ADMINBOT_LOCAL_MODEL: "gemma4:e4b-it-qat",
    });

    await expect(
      model.classify({
        from: "student@example.com",
        fromName: "Genis",
        subject: "Research opportunity",
        body: "I would like to work with your lab.",
      }),
    ).resolves.toMatchObject({
      category: "student_reachout",
      confidence: 0.97,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "gemma4:e4b-it-qat",
      stream: false,
      format: { type: "object" },
      options: { temperature: 0, num_predict: 1200 },
    });
  });

  it("reports an actionable error when Ollama is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const model = new AdminBotEmailModel(fetchMock);

    await expect(
      model.classify({
        from: "student@example.com",
        subject: "Research",
        body: "Can I join?",
      }),
    ).rejects.toThrow("local Ollama is unavailable at http://127.0.0.1:11434: fetch failed");
  });

  it("rejects malformed model output before any action handler sees it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          message: { content: '{"category":"student_reachout"}' },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const model = new AdminBotEmailModel(fetchMock);

    await expect(
      model.classify({
        from: "student@example.com",
        subject: "Research",
        body: "Can I join?",
      }),
    ).rejects.toThrow();
  });
});
