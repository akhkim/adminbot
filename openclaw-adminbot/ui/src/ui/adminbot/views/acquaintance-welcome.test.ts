/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ token: "synthetic-session" }));
vi.mock("../auth/session.ts", async (original) => ({
  ...(await original<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: session.token }),
  resolveAdminBotBaseUrl: () => "http://127.0.0.1:8765",
}));
import { AcquaintanceWelcome } from "./acquaintance-welcome.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  session.token = "synthetic-session";
});
async function mount() {
  const element = new AcquaintanceWelcome();
  element.memberId = "synthetic-acquaintance";
  element.sessionToken = session.token;
  document.body.append(element);
  await element.updateComplete;
  return element;
}
const preview = {
  email: "correspondence@example.test",
  subject: "Getting connected",
  body: "Hi Ada, welcome to the community.",
  preview_hash: "synthetic-reviewed-hash",
};

describe("acquaintance welcome composer", () => {
  it("previews the recipient and exact copy before queueing a separate approval", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => preview })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ detail: "Queued for a separate approval. No email was sent." }),
      });
    vi.stubGlobal("fetch", fetch);
    const element = await mount();
    (element.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(element.textContent).toContain(preview.email));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain(preview.body);
    const queue = [...element.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Queue this exact email"),
    )!;
    queue.click();
    await vi.waitFor(() => expect(element.textContent).toContain("No email was sent."));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain("/onboarding/welcome/queue");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      resend: false,
      preview_hash: preview.preview_hash,
    });
  });
  it("invalidates a preview after editing and does not trigger the member form's autosave", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => preview }));
    const element = await mount();
    (element.querySelector("input[type=checkbox]") as HTMLInputElement).click();
    await element.updateComplete;
    const body = element.querySelector("textarea")!;
    body.value = "Synthetic custom welcome";
    const bubbled = vi.fn();
    document.body.addEventListener("input", bubbled, { once: true });
    body.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(bubbled).not.toHaveBeenCalled();
    document.body.removeEventListener("input", bubbled);
    (element.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(element.textContent).toContain(preview.email));
    body.value = "Revised custom welcome";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector('[aria-label="Exact welcome email preview"]')).toBeNull();
  });
  it("clears private copy when the member or session changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => preview }));
    const element = await mount();
    (element.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(element.textContent).toContain(preview.email));
    element.sessionToken = "different-synthetic-session";
    await element.updateComplete;
    expect(element.textContent).not.toContain(preview.email);
  });
});
