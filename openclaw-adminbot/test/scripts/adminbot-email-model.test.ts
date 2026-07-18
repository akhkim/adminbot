import { describe, expect, it, vi } from "vitest";
import { AdminBotEmailModel, gmailOneHourQuery } from "../../scripts/adminbot-email-model.js";

describe("AdminBot email model", () => {
  it("queries an exact one-hour Gmail epoch window", () => {
    expect(gmailOneHourQuery(new Date("2026-07-18T12:00:00Z"))).toBe(
      "in:inbox after:1784372400 before:1784376001 -from:jinesis.adminbot@gmail.com",
    );
  });

  it("uses the loopback vLLM chat API with constrained non-thinking JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
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
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const model = new AdminBotEmailModel(fetchMock, {
      ADMINBOT_LOCAL_BASE_URL: "http://127.0.0.1:8000/v1",
      ADMINBOT_LOCAL_MODEL: "nvidia/Qwen3.5-122B-A10B-NVFP4",
      VLLM_API_KEY: "test-key",
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
    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-key" });
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "nvidia/Qwen3.5-122B-A10B-NVFP4",
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: { name: "email_classification", strict: true },
      },
    });
  });

  it("rejects malformed model output before any action handler sees it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"category":"student_reachout"}' } }],
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
