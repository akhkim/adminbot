import { describe, expect, it, vi } from "vitest";
import { AdminBotEmailModel, gmailOneHourQuery } from "../../scripts/adminbot-email-model.js";

describe("AdminBot email model", () => {
  it("queries an exact one-hour Gmail epoch window", () => {
    // The mailbox to exclude is deployment configuration, so the fixture supplies it rather than
    // the query naming a real account.
    expect(
      gmailOneHourQuery(new Date("2026-07-18T12:00:00Z"), {
        ADMINBOT_BOT_EMAIL: "adminbot@example.com",
      }),
    ).toBe("in:inbox after:1784372400 before:1784376001 -from:adminbot@example.com");
    // Unconfigured, it refuses rather than build a query that matches the bot's own sends.
    expect(() => gmailOneHourQuery(new Date("2026-07-18T12:00:00Z"), {})).toThrow(
      /ADMINBOT_BOT_EMAIL/u,
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

  it("drafts flexible email text through the constrained local model", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    subject: "Research application next step",
                    body: "Hi Genis,\n\nYour work on robotics sounds relevant. Please apply at https://example.test/app.\n\nBest,\nZhijing",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const model = new AdminBotEmailModel(fetchMock);

    await expect(
      model.draft(
        {
          from: "student@example.com",
          fromName: "Genis",
          subject: "Robotics research",
          body: "I work on robot learning and would like to join.",
        },
        {
          purpose: "student_outreach",
          recipientName: "Genis",
          guidance: "Acknowledge supported interests and invite an application.",
          requiredFacts: ["The application form is https://example.test/app."],
        },
      ),
    ).resolves.toMatchObject({
      subject: "Research application next step",
      body: expect.stringContaining("robotics"),
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
      response_format: { json_schema: { name: string } };
    };
    expect(payload.response_format.json_schema.name).toBe("email_draft");
    expect(payload.messages[0]?.content).toContain("instead of a fixed template");
    expect(payload.messages[0]?.content).toContain("untrusted data");
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
