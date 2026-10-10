/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: "synthetic-token", fetch: vi.fn(), queue: vi.fn() }));
vi.mock("../auth/session.ts", () => ({
  fetchMemberResource: mocks.fetch,
  queueMemberOnboardingGuide: mocks.queue,
  loadStoredMemberSession: () => (mocks.token ? { sessionToken: mocks.token } : null),
  resolveAdminBotBaseUrl: () => "http://127.0.0.1:8765",
}));
import { MemberGuideStatus } from "./member-guide-status.ts";

let element: MemberGuideStatus;
async function flush() {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}
async function mount(status: string) {
  mocks.fetch.mockResolvedValue({ ok: true, value: { status, detail: `Synthetic ${status}.` } });
  element = document.createElement("adminbot-member-guide-status") as MemberGuideStatus;
  element.memberId = "synthetic-member";
  document.body.append(element);
  await flush();
}
function button(label: string) {
  return [...element.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeTruthy();
  target!.click();
  await flush();
}

beforeEach(() => {
  mocks.token = "synthetic-token";
  mocks.fetch.mockReset();
  mocks.queue.mockReset().mockResolvedValue({
    ok: true,
    value: {
      status: "done",
      proposal_id: "p1",
      template_id: "member",
      email: "synthetic@example.test",
      detail: "sent to synthetic@example.test",
    },
  });
});
afterEach(() => {
  element?.remove();
});

describe("onboarding email send and resend", () => {
  it("offers a first send for a member never mailed, and sends only after confirmation", async () => {
    await mount("not_queued");
    await click("Send onboarding email");
    expect(mocks.queue).not.toHaveBeenCalled();
    await click("Confirm");
    expect(mocks.queue).toHaveBeenCalledWith(
      "synthetic-member",
      "synthetic-token",
      "http://127.0.0.1:8765",
      undefined,
      { resend: false },
    );
    expect(element.textContent).toContain("sent to synthetic@example.test");
  });

  it("asks the service for a resend once the guide has reached them", async () => {
    await mount("sent");
    await click("Resend onboarding email");
    expect(element.textContent).toContain("not filed a second time");
    await click("Confirm");
    expect(mocks.queue).toHaveBeenCalledWith(
      "synthetic-member",
      "synthetic-token",
      "http://127.0.0.1:8765",
      undefined,
      { resend: true },
    );
  });

  it("sends nothing when the admin cancels", async () => {
    await mount("failed");
    await click("Send onboarding email");
    await click("Cancel");
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(button("Send onboarding email")).toBeTruthy();
  });

  it.each(["pending", "approved", "not_applicable"])(
    "offers no send while the status is %s",
    async (status) => {
      await mount(status);
      expect(button("Send onboarding email")).toBeUndefined();
      expect(button("Resend onboarding email")).toBeUndefined();
    },
  );

  it("shows the service's refusal", async () => {
    mocks.queue.mockResolvedValue({
      ok: false,
      kind: "conflict",
      message: "the member onboarding guide for synthetic@example.test is already queued or sent",
    });
    await mount("sent");
    await click("Resend onboarding email");
    await click("Confirm");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("already queued");
  });
});
