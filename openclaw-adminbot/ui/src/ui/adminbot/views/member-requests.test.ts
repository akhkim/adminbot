/* @vitest-environment jsdom */

// Member requests on the Lab Members tab. What these cover is who sees what: an admin the queue
// with the access level approval grants, a member their own requests, and the non-admin form that
// files a request rather than writing the roster.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { MemberRequestView } from "../auth/session.ts";
import { createEmptyAdminBotMemberRequests } from "../controllers/member-requests.ts";
import {
  type MemberRequestsProps,
  renderMemberRequestForm,
  renderMemberRequests,
} from "./member-requests.ts";

// jsdom has no Popover API; the form closes its popover after a successful send.
HTMLElement.prototype.hidePopover ??= () => {};

function request(overrides: Partial<MemberRequestView> = {}): MemberRequestView {
  return {
    id: "mreq_1",
    status: "pending",
    requested_by: "pat",
    requested_by_name: "Pat",
    profile: { name: "Ada Lovelace", email: "ada@example.org", member_type: "full" },
    note: "Started this week.",
    created_at: "2026-09-24T10:00:00.000Z",
    access_level: "member",
    ...overrides,
  };
}

function draw(
  template: (props: MemberRequestsProps) => unknown,
  props: Partial<MemberRequestsProps> & { requests?: MemberRequestView[] } = {},
) {
  const { requests = [request()], ...rest } = props;
  const container = document.createElement("div");
  document.body.append(container);
  render(
    template({
      isAdmin: true,
      state: { ...createEmptyAdminBotMemberRequests(), requests, loadedAt: 1 },
      ...rest,
    }),
    container,
  );
  return container;
}

describe("member requests", () => {
  it("shows an admin each pending request with who asked and what approving grants", () => {
    const container = draw(renderMemberRequests, {
      requests: [request(), request({ id: "mreq_2", status: "rejected" })],
    });
    const cards = container.querySelectorAll('[data-testid="member-request"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Ada Lovelace");
    expect(cards[0]?.textContent).toContain("Requested by Pat");
    expect(cards[0]?.textContent).toContain("member");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("warns when the requested type would make them an admin", () => {
    const container = draw(renderMemberRequests, {
      requests: [request({ access_level: "admin" })],
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("admin");
  });

  it("passes the onboarding tick and the decline reason as they are when pressed", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const container = draw(renderMemberRequests, { onApprove, onReject });
    const onboard = container.querySelector<HTMLInputElement>('input[name="onboard"]')!;
    onboard.checked = false;
    container.querySelector<HTMLButtonElement>('[data-testid="member-request-approve"]')!.click();
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "mreq_1" }), {
      onboard: false,
    });
    container.querySelector<HTMLInputElement>('input[name="reason"]')!.value = "Duplicate";
    container.querySelector<HTMLButtonElement>('[data-testid="member-request-reject"]')!.click();
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: "mreq_1" }), "Duplicate");
  });

  it("shows a member their own requests and the reason one was declined", () => {
    const container = draw(renderMemberRequests, {
      isAdmin: false,
      requests: [request({ status: "rejected", decision_note: "Already on the roster." })],
    });
    expect(container.textContent).toContain("Your requests");
    expect(container.textContent).toContain("Declined");
    expect(container.textContent).toContain("Already on the roster.");
  });

  it("renders nothing for an admin with an empty queue", () => {
    const container = draw(renderMemberRequests, { requests: [] });
    expect(container.querySelector('[data-testid="member-requests"]')).toBeNull();
  });

  it("gives a non-admin a form that files a request, and none to an admin", () => {
    expect(
      draw(renderMemberRequestForm, { onSubmit: vi.fn() }).querySelector(
        '[data-testid="member-request-form"]',
      ),
    ).toBeNull();
    const onSubmit = vi.fn(async () => true);
    const container = draw(renderMemberRequestForm, { isAdmin: false, onSubmit });
    const form = container.querySelector("form")!;
    form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Ada Lovelace";
    form.querySelector<HTMLInputElement>('input[name="email"]')!.value = "ada@example.org";
    form.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!.value = "New RA";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Ada Lovelace",
      email: "ada@example.org",
      note: "New RA",
    });
  });
});
