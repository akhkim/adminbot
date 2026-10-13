import { describe, expect, it } from "vitest";
import {
  adminBotCalendarEmail,
  adminBotCalendarShareEmail,
  adminBotIsGmailAddress,
  adminBotOutreachEmail,
} from "./member-outreach-email.js";

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

describe("calendar email fallback", () => {
  it("prefers the explicit Calendar account, then login, then saved contact", () => {
    expect(
      adminBotCalendarEmail({
        calendar_email: "calendar@example.test",
        email: "login@example.test",
        correspondence_email: "contact@example.test",
      }),
    ).toBe("calendar@example.test");
    expect(
      adminBotCalendarEmail({
        calendar_email: "   ",
        email: "login@example.test",
        correspondence_email: "contact@example.test",
      }),
    ).toBe("login@example.test");
    expect(
      adminBotCalendarEmail({
        email: " ",
        correspondence_email: "contact@example.test / other@example.test",
      }),
    ).toBe("contact@example.test");
    expect(adminBotCalendarEmail({ calendar_email: "bad@", email: "login@example.test" })).toBe(
      "login@example.test",
    );
    expect(adminBotCalendarEmail({})).toBe("");
  });

  it("prefers a Gmail address over a departmental login", () => {
    expect(
      adminBotCalendarEmail({
        email: "login@cs.example.test",
        correspondence_email: "Someone@umontreal.example / someone@gmail.com",
      }),
    ).toBe("someone@gmail.com");
  });
});

describe("lab calendar share address", () => {
  it("uses the explicit Calendar email, then any Gmail address", () => {
    expect(
      adminBotCalendarShareEmail({
        calendar_email: "person@workspace.example.test",
        email: "person@gmail.com",
      }),
    ).toBe("person@workspace.example.test");
    expect(
      adminBotCalendarShareEmail({
        email: "login@cs.example.test",
        correspondence_email: "p@GMAIL.com",
      }),
    ).toBe("p@GMAIL.com");
    expect(adminBotCalendarShareEmail({ email: "p@googlemail.com" })).toBe("p@googlemail.com");
  });

  it("never shares with an address that is not a Google account", () => {
    expect(
      adminBotCalendarShareEmail({
        email: "login@cs.example.test",
        correspondence_email: "contact@example.test",
      }),
    ).toBe("");
    expect(adminBotCalendarShareEmail({ calendar_email: "bad@", email: "x@gmail.com.evil" })).toBe(
      "",
    );
  });

  it("recognizes Gmail addresses only", () => {
    expect(adminBotIsGmailAddress(" a@gmail.com ")).toBe(true);
    expect(adminBotIsGmailAddress("a@notgmail.com")).toBe(false);
    expect(adminBotIsGmailAddress("a@gmail.com.example")).toBe(false);
  });
});
