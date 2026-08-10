import { describe, expect, it, vi } from "vitest";
import { AdminBotEmailModel } from "../../scripts/adminbot-email-model.js";

describe("AdminBot calendar extraction", () => {
  it("uses an all-day range only when the email has no time", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Test",
                  start: "2026-07-30",
                  end: "2026-07-31",
                  allDay: true,
                  description: null,
                  location: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const model = new AdminBotEmailModel(fetchMock);

    await expect(
      model.calendar({
        from: "pi@example.edu",
        subject: "Create event",
        body: "Add an event called Test on July 30, 2026.",
      }),
    ).resolves.toMatchObject({
      summary: "Test",
      start: "2026-07-30",
      end: "2026-07-31",
      allDay: true,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(payload.messages[0]?.content).toContain("Only when no time is stated");
  });
});
