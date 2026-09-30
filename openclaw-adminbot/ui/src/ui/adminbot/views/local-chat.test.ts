/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: "synthetic-token", fetch: vi.fn(), send: vi.fn() }));
vi.mock("../auth/session.ts", () => ({
  fetchMemberResource: mocks.fetch,
  sendLocalChat: mocks.send,
  loadStoredMemberSession: () => (mocks.token ? { sessionToken: mocks.token } : null),
  resolveAdminBotBaseUrl: () => "http://127.0.0.1:8765",
}));
import { LocalChat } from "./local-chat.ts";
class TestLocalChat extends LocalChat {}
customElements.define("test-local-chat", TestLocalChat);
let element: LocalChat;
async function flush() {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}
beforeEach(async () => {
  mocks.token = "synthetic-token";
  mocks.fetch
    .mockReset()
    .mockResolvedValue({ ok: true, value: { route: "local", model: "synthetic-local" } });
  mocks.send.mockReset().mockResolvedValue({
    ok: true,
    value: { route: "local", model: "synthetic-local", output: "<script>plain text</script>" },
  });
  element = document.createElement("test-local-chat") as LocalChat;
  element.sessionToken = mocks.token;
  document.body.append(element);
  await flush();
});
afterEach(() => {
  element?.remove();
});
function send() {
  const input = element.querySelector("textarea")!;
  input.value = "Synthetic question";
  input.dispatchEvent(new Event("input"));
  element.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
}
describe("local chat UI", () => {
  it("identifies the local model and renders responses as plain text", async () => {
    expect(element.textContent).toContain("synthetic-local");
    send();
    await flush();
    expect(mocks.send).toHaveBeenCalledWith(
      [{ role: "user", content: "Synthetic question" }],
      mocks.token,
      "http://127.0.0.1:8765",
      expect.any(AbortSignal),
    );
    expect(element.textContent).toContain("<script>plain text</script>");
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector("textarea")!.value).toBe("");
    element.querySelector<HTMLButtonElement>('[aria-label="Clear chat"]')!.click();
    await flush();
    expect(element.textContent).not.toContain("plain text</script>");
  });
  it("hides the chat when server access is denied", async () => {
    mocks.fetch.mockResolvedValue({ ok: false });
    mocks.token = "other-token";
    element.sessionToken = mocks.token;
    await flush();
    expect(element.querySelector("form")).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("shows local failure and retains the question for retry", async () => {
    mocks.send.mockResolvedValue({ ok: false });
    send();
    await flush();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("No external model");
    expect(element.querySelector("textarea")!.value).toBe("Synthetic question");
  });
  it("prevents duplicate submits and discards an in-flight answer after session change", async () => {
    let finish!: (value: unknown) => void;
    mocks.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    send();
    send();
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain("Waiting for local model");
    mocks.token = "";
    element.sessionToken = "";
    await flush();
    finish({
      ok: true,
      value: { route: "local", model: "synthetic-local", output: "must disappear" },
    });
    await flush();
    expect(element.textContent).not.toContain("must disappear");
    expect(element.querySelector("form")).toBeNull();
  });
  it("keeps conversations and drafts separate, supports search, and clears all session history", async () => {
    send();
    await flush();
    element.querySelector<HTMLButtonElement>(".lc-new")!.click();
    await flush();
    const input = element.querySelector("textarea")!;
    input.value = "Second private draft";
    input.dispatchEvent(new Event("input"));
    await flush();
    const first = [...element.querySelectorAll<HTMLButtonElement>(".lc-conversation")].find((row) =>
      row.textContent?.includes("Synthetic question"),
    )!;
    first.click();
    await flush();
    expect(element.querySelector("textarea")!.value).toBe("");
    expect(element.querySelector(".lc-message-body")?.textContent).toContain("Synthetic question");
    const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Second private";
    search.dispatchEvent(new Event("input"));
    await flush();
    expect(element.querySelectorAll(".lc-conversation")).toHaveLength(1);
    element.querySelector<HTMLButtonElement>(".lc-conversation")!.click();
    await flush();
    expect(element.querySelector("textarea")!.value).toBe("Second private draft");
    expect(element.querySelectorAll(".lc-message")).toHaveLength(0);
    element.querySelector<HTMLButtonElement>(".lc-clear-all")!.click();
    await flush();
    expect(element.textContent).not.toContain("Second private");
    expect(element.querySelectorAll(".lc-conversation")).toHaveLength(1);
  });
  it("formats Markdown without HTML execution or remote image loading", async () => {
    mocks.send.mockResolvedValue({
      ok: true,
      value: {
        route: "local",
        model: "synthetic-local",
        output:
          "**Bold answer**\n\n```python\nprint(42)\n```\n\n![remote](https://example.test/private)\n\n<script>alert(1)</script>",
      },
    });
    send();
    await flush();
    expect(element.querySelector(".lc-message--assistant strong")?.textContent).toBe("Bold answer");
    expect(element.querySelector("pre code")?.textContent).toContain("print(42)");
    expect(element.querySelector("img, iframe, script")).toBeNull();
    expect(element.textContent).toContain("[Image omitted]");
  });
  it("aborts stopped work and never applies its late answer to another conversation", async () => {
    let finish!: (value: unknown) => void;
    mocks.send.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    send();
    await flush();
    const signal = mocks.send.mock.calls[0]![3] as AbortSignal;
    element.querySelector<HTMLButtonElement>('[aria-label="Stop generation"]')!.click();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(element.querySelector("textarea")!.disabled).toBe(false);
    expect(element.querySelector("textarea")!.value).toBe("Synthetic question");
    element.querySelector<HTMLButtonElement>(".lc-new")!.click();
    await flush();
    finish({ ok: true, value: { model: "synthetic-local", output: "Late private answer" } });
    await flush();
    expect(element.textContent).not.toContain("Late private answer");
  });
  it("closes the full-screen dialog when clearing all chats", async () => {
    const dialog = element.querySelector("dialog")!;
    dialog.showModal = vi.fn(() => {
      dialog.open = true;
    });
    dialog.close = vi.fn(() => {
      dialog.open = false;
      dialog.dispatchEvent(new Event("close"));
    });
    element.querySelector<HTMLButtonElement>('[aria-label="Expand chat"]')!.click();
    await flush();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.querySelector("form")).not.toBeNull();
    dialog.querySelector<HTMLButtonElement>(".lc-clear-all")!.click();
    await flush();
    expect(dialog.open).toBe(false);
    expect(element.querySelectorAll("form")).toHaveLength(1);
  });
});
