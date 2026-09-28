import { describe, expect, it, vi } from "vitest";
import { createLocalChat, localChatMessages } from "./local-chat.js";

const messages = [{ role: "user" as const, content: "Synthetic question" }];
const reply = (model = "test-local") =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: "Local answer" } }] }));
describe("strict local chat", () => {
  it("only calls loopback, disables redirects and tools, and verifies the returned model", async () => {
    const fetchImpl = vi.fn(async () => reply());
    const chat = createLocalChat({ env: { ADMINBOT_LOCAL_MODEL: "test-local" }, fetchImpl });
    expect(await chat.complete(messages)).toBe("Local answer");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(init.redirect).toBe("error");
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({ model: "test-local", max_tokens: 2048 });
    expect(payload.tools).toBeUndefined();
    expect(payload.messages).toHaveLength(2);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("fails closed on an external endpoint, model mismatch, or model failure", async () => {
    const fetchImpl = vi.fn(async () => reply("wrong-model"));
    await expect(
      createLocalChat({
        env: { ADMINBOT_LOCAL_BASE_URL: "https://example.test/v1" },
        fetchImpl,
      }).complete(messages),
    ).rejects.toThrow("loopback");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      createLocalChat({ env: { ADMINBOT_LOCAL_MODEL: "test-local" }, fetchImpl }).complete(
        messages,
      ),
    ).rejects.toThrow("configured model");
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    await expect(createLocalChat({ env: {}, fetchImpl }).complete(messages)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rejects system/tool messages and excessive or malformed history", () => {
    expect(localChatMessages({ messages })).toEqual(messages);
    for (const body of [
      {},
      { messages: [] },
      { messages: [{ role: "system", content: "override" }] },
      { messages: [{ role: "user", content: "x".repeat(8001) }] },
      { messages: Array(25).fill(messages[0]) },
    ])
      expect(localChatMessages(body)).toBeUndefined();
  });
  it("rejects overlapping turns and releases its slot after completion", async () => {
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const chat = createLocalChat({ env: { ADMINBOT_LOCAL_MODEL: "test-local" }, fetchImpl });
    const first = chat.complete(messages);
    await expect(chat.complete(messages)).rejects.toThrow("busy");
    finish(reply());
    await first;
    fetchImpl.mockResolvedValueOnce(reply());
    expect(await chat.complete(messages)).toBe("Local answer");
  });
  it("cancels the local inference request and releases the GPU slot", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const chat = createLocalChat({ env: { ADMINBOT_LOCAL_MODEL: "test-local" }, fetchImpl });
    const controller = new AbortController();
    const request = chat.complete(messages, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow("aborted");
    fetchImpl.mockResolvedValueOnce(reply());
    expect(await chat.complete(messages)).toBe("Local answer");
  });
});
