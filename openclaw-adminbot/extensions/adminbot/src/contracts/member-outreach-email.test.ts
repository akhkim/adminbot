import { describe, expect, it } from "vitest";
import { adminBotOutreachEmail } from "./member-outreach-email.js";

describe("adminBotOutreachEmail", () => {
  it("prefers the correspondence address over the login address", () => {
    expect(
      adminBotOutreachEmail({
        email: "andrei@cs.toronto.edu",
        correspondence_email: "andrei.muresanu@uwaterloo.ca",
      }),
    ).toBe("andrei.muresanu@uwaterloo.ca");
  });

  it("falls back to the login address when no correspondence address is on file", () => {
    expect(adminBotOutreachEmail({ email: "arth@cs.toronto.edu" })).toBe("arth@cs.toronto.edu");
  });

  it("reaches a member who has only a correspondence address", () => {
    // Four members on the live roster are exactly this, and every one of them was skipped as
    // "member has no email" while the lab had an address for them the whole time.
    expect(adminBotOutreachEmail({ correspondence_email: "terry@safe.eu" })).toBe("terry@safe.eu");
  });

  it("takes the first address when the field holds two", () => {
    expect(
      adminBotOutreachEmail({
        email: "ariankh@cs.toronto.edu",
        correspondence_email: "Arian.Khorasani@umontreal.ca / Ariankhorasani1@gmail.com",
      }),
    ).toBe("Arian.Khorasani@umontreal.ca");
  });

  it.each([", ", "; ", " "])("splits on %j as well as a slash", (separator) => {
    expect(
      adminBotOutreachEmail({
        correspondence_email: `first@example.org${separator}second@x.io`,
      }),
    ).toBe("first@example.org");
  });

  it("falls through to the login address when the correspondence field holds no address", () => {
    // Free text, so it holds prose: "ask me on Slack" must not become a destination.
    expect(
      adminBotOutreachEmail({
        email: "narmeen@cs.toronto.edu",
        correspondence_email: "ask me on Slack",
      }),
    ).toBe("narmeen@cs.toronto.edu");
  });

  it("is empty when neither address is usable", () => {
    expect(adminBotOutreachEmail({})).toBe("");
    expect(adminBotOutreachEmail({ email: "   ", correspondence_email: "@" })).toBe("");
  });
});
