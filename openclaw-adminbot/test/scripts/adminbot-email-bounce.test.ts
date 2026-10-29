import { describe, expect, it } from "vitest";
import {
  deliveryFailureReason,
  parseDeliveryFailure,
} from "../../scripts/adminbot-email-bounce.js";

const gmailBounce = {
  from: "mailer-daemon@googlemail.com",
  subject: "Delivery Status Notification (Failure)",
  body: [
    "Address not found",
    "",
    "Your message wasn't delivered to member@cs.example.edu because the address couldn't be found, or is unable to receive mail.",
    "",
    "The response from the remote server was:",
    "550 5.1.1 <member@cs.example.edu>: Recipient address rejected: User unknown",
  ].join("\n"),
};

describe("parseDeliveryFailure", () => {
  it("reads the recipient and the server reply off a Gmail bounce", () => {
    expect(parseDeliveryFailure(gmailBounce)).toEqual({
      recipients: ["member@cs.example.edu"],
      diagnostic: "550 5.1.1 <member@cs.example.edu>: Recipient address rejected: User unknown",
    });
  });

  it("reads a Gmail blocked-message notice", () => {
    expect(
      parseDeliveryFailure({
        ...gmailBounce,
        body: "Message blocked\n\nYour message to Someone@Example.org has been blocked. See technical details below for more information.",
      }),
    ).toEqual({ recipients: ["someone@example.org"] });
  });

  it("reads an RFC 3464 notice from a postmaster", () => {
    expect(
      parseDeliveryFailure({
        from: "postmaster@mail.example.org",
        subject: "Undeliverable: Your onboarding guide",
        body: "Reporting-MTA: dns; mx.example.org\nFinal-Recipient: rfc822; gone@example.org\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user is unknown\n",
      }),
    ).toEqual({ recipients: ["gone@example.org"], diagnostic: "550 5.1.1 user is unknown" });
  });

  it("leaves a delay warning alone", () => {
    expect(
      parseDeliveryFailure({ ...gmailBounce, subject: "Delivery Status Notification (Delay)" }),
    ).toBeUndefined();
  });

  it("leaves a person writing about a failed delivery alone", () => {
    expect(
      parseDeliveryFailure({ ...gmailBounce, from: "student@example.com" }),
    ).toBeUndefined();
  });

  it("falls back to the classifier when no recipient can be found", () => {
    expect(
      parseDeliveryFailure({ ...gmailBounce, body: "Something went wrong delivering your mail." }),
    ).toBeUndefined();
  });
});

describe("deliveryFailureReason", () => {
  it("names the address and the server reply", () => {
    const reason = deliveryFailureReason(parseDeliveryFailure(gmailBounce)!);
    expect(reason).toContain("member@cs.example.edu");
    expect(reason).toContain("550 5.1.1");
  });
});
