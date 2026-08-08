// @vitest-environment happy-dom

import type { Registration } from "@adminbot/api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistrationReviewClient } from "./api-client.js";
import { AdminBotRegistrationReviewApp } from "./registration-review-app.js";

if (!customElements.get("adminbot-registration-review-app")) {
  customElements.define("adminbot-registration-review-app", AdminBotRegistrationReviewApp);
}
afterEach(() => document.body.replaceChildren());

describe("AdminBotRegistrationReviewApp", () => {
  it("loads pending requests and submits an approval decision", async () => {
    const registration = pendingRegistration();
    const decide = vi.fn(async () => ({ ...registration, state: "approved" as const }));
    const list = vi.fn().mockResolvedValueOnce([registration]).mockResolvedValueOnce([]);
    const element = document.createElement("adminbot-registration-review-app") as AdminBotRegistrationReviewApp;
    element.client = { list, decide };
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector(".registration")).not.toBeNull());
    const reason = element.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
    if (reason !== undefined && reason !== null) reason.value = "Identity checked";
    element.shadowRoot?.querySelector<HTMLButtonElement>(".secondary")?.click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    expect(decide).toHaveBeenCalledWith(registration.id, { decision: "approve", reason: "Identity checked" });
    expect(list).toHaveBeenLastCalledWith("submitted");
  });
});

function pendingRegistration(): Registration {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    kind: "signup",
    requestedLoginHandle: "applicant@example.com",
    requestedDisplayName: "Synthetic Applicant",
    state: "submitted",
    profile: { displayName: "Synthetic Applicant", affiliation: "Example University" },
    version: 1,
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
  };
}
