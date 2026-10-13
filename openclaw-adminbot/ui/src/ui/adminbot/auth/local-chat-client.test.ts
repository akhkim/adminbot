/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendLocalChat } from "../api/assistant.ts";
afterEach(() => vi.unstubAllGlobals());
describe("local chat client", () => {
  it("forwards cancellation, omits cookies and validates local routing", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ route: "local", model: "synthetic-model", output: "Synthetic answer" }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(
      (
        await sendLocalChat(
          [{ role: "user", content: "Synthetic" }],
          "synthetic-token",
          "http://127.0.0.1:8765",
          controller.signal,
        )
      ).ok,
    ).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/local-chat",
      expect.objectContaining({ method: "POST", credentials: "omit", signal: controller.signal }),
    );
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ route: "remote", model: "synthetic-model", output: "Must not render" }),
      ),
    );
    expect((await sendLocalChat([], "synthetic-token", "http://127.0.0.1:8765")).ok).toBe(false);
    fetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    expect(
      (await sendLocalChat([], "synthetic-token", "http://127.0.0.1:8765", controller.signal)).ok,
    ).toBe(false);
  });
});
