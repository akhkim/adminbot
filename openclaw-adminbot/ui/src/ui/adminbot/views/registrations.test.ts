/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import type { MemberRegistration } from "../auth/session.ts";
import { renderAdminBotRegistrations, type AdminBotRegistrationsProps } from "./registrations.ts";

function baseProps(
  overrides: Partial<AdminBotRegistrationsProps> = {},
): AdminBotRegistrationsProps {
  return {
    registrations: [],
    loading: false,
    error: null,
    busyId: null,
    notice: null,
    onDecide: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

const claimRegistration: MemberRegistration = {
  id: "reg-claim",
  kind: "claim",
  email: "ada@lab.co",
  status: "pending",
  created_at: "2026-07-01T10:00:00.000Z",
  member_id: "member-7",
  member_name: "Ada Lovelace",
};

const signupRegistration: MemberRegistration = {
  id: "reg-signup",
  kind: "signup",
  email: "grace@lab.co",
  status: "pending",
  created_at: "2026-07-02T10:00:00.000Z",
  profile: {
    name: "Grace Hopper",
    affiliation: "Navy Lab",
    research_topics: ["compilers", "languages"],
    timezone: "America/New_York",
  },
};

describe("renderAdminBotRegistrations", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("shows a calm empty state with no pending requests", async () => {
    const container = document.createElement("div");
    render(renderAdminBotRegistrations(baseProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("No pending registrations.");
    expect(container.querySelector(".adminbot-registration")).toBeNull();
  });

  it("shows a loading state before the first list arrives", async () => {
    const container = document.createElement("div");
    render(renderAdminBotRegistrations(baseProps({ loading: true })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Loading member requests");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a pending claim with the roster member name and id", async () => {
    const container = document.createElement("div");
    render(
      renderAdminBotRegistrations(baseProps({ registrations: [claimRegistration] })),
      container,
    );
    await Promise.resolve();

    const card = container.querySelector(".adminbot-registration");
    expect(card?.querySelector(".ab-chip")?.textContent?.trim()).toBe("Roster claim");
    expect(card?.querySelector(".adminbot-registration__member")?.textContent?.trim()).toBe(
      "Ada Lovelace",
    );
    expect(card?.textContent).toContain("member-7");
    expect(card?.textContent).toContain("ada@lab.co");
  });

  it("renders a pending signup with its submitted profile fields", async () => {
    const container = document.createElement("div");
    render(
      renderAdminBotRegistrations(baseProps({ registrations: [signupRegistration] })),
      container,
    );
    await Promise.resolve();

    const card = container.querySelector(".adminbot-registration");
    expect(card?.querySelector(".ab-chip")?.textContent?.trim()).toBe("New signup");
    expect(card?.querySelector(".adminbot-registration__member")?.textContent?.trim()).toBe(
      "Grace Hopper",
    );
    const fields = Array.from(card?.querySelectorAll(".adminbot-registration__field") ?? []).map(
      (field) => field.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(fields).toContain("Affiliation Navy Lab");
    // List-valued profile fields render as a readable comma list, not "[object Object]".
    expect(fields).toContain("Research topics compilers, languages");
    expect(fields).toContain("Timezone America/New_York");
  });

  it("routes approve and reject to the right registration id", async () => {
    const container = document.createElement("div");
    const decisions: Array<[string, string]> = [];
    render(
      renderAdminBotRegistrations(
        baseProps({
          registrations: [claimRegistration, signupRegistration],
          onDecide: (id, decision) => decisions.push([id, decision]),
        }),
      ),
      container,
    );
    await Promise.resolve();

    const cards = container.querySelectorAll(".adminbot-registration");
    cards[0]?.querySelectorAll<HTMLButtonElement>("button")[0]?.click();
    cards[1]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();

    expect(decisions).toEqual([
      ["reg-claim", "approve"],
      ["reg-signup", "reject"],
    ]);
  });

  it("disables every decision button while one is in flight", async () => {
    const container = document.createElement("div");
    render(
      renderAdminBotRegistrations(
        baseProps({
          registrations: [claimRegistration, signupRegistration],
          busyId: "reg-claim",
        }),
      ),
      container,
    );
    await Promise.resolve();

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".adminbot-registration button"),
    );
    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("surfaces a decision failure notice", async () => {
    const container = document.createElement("div");
    render(
      renderAdminBotRegistrations(
        baseProps({
          registrations: [claimRegistration],
          notice: { kind: "error", text: "Couldn't record that decision." },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const callout = container.querySelector(".callout");
    expect(callout?.classList.contains("danger")).toBe(true);
    expect(callout?.textContent?.trim()).toBe("Couldn't record that decision.");
  });

  it("explains a forbidden session without offering a retry", async () => {
    const container = document.createElement("div");
    render(renderAdminBotRegistrations(baseProps({ error: "forbidden" })), container);
    await Promise.resolve();

    expect(container.querySelector(".card-sub")?.textContent?.trim()).toBe(
      "Only admins and core members can review member requests.",
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers a retry when the service is unreachable", async () => {
    const container = document.createElement("div");
    let retried = 0;
    render(
      renderAdminBotRegistrations(
        baseProps({ error: "unreachable", onRefresh: () => (retried += 1) }),
      ),
      container,
    );
    await Promise.resolve();

    const retry = container.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent?.trim()).toBe("Retry");
    retry?.click();
    expect(retried).toBe(1);
  });
});
