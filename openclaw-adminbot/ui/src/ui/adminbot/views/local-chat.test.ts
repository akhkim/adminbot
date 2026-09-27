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
    );
    expect(element.textContent).toContain("<script>plain text</script>");
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector("textarea")!.value).toBe("");
    element.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
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
});
