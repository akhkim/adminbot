// Public-to-lab vs private-to-self: which answers the roster serves to everyone, and which it does
// not. The roster loads whole records at sign-in, so a field on the record is readable in devtools
// by every member whatever the UI chooses to draw -- the redaction is the only thing that is real.
import { describe, expect, it } from "vitest";
import {
  adminBotConfidentialMemberFields,
  adminBotMemberFieldVisibility,
  redactConfidentialMemberFields,
} from "./actions.js";

const member = {
  id: "mei",
  name: "Mei Chen",
  github_url: "https://github.com/mei",
  openreview_id: "~Mei_Chen1",
  linkedin_url: "https://linkedin.com/in/mei",
  cv_url: "https://drive.google.com/cv",
  correspondence_email: "mei@example.com",
  whatsapp: "+1 555 0100",
  intake_form_url: "https://forms.google.com/response",
  personal_circumstances: "Caring for a relative this term.",
};

describe("member field visibility", () => {
  it("keeps the professional identity fields lab-visible", () => {
    for (const key of ["github_url", "openreview_id", "linkedin_url", "cv_url", "name"]) {
      expect(adminBotMemberFieldVisibility(key), key).toBe("lab");
    }
  });

  it("keeps a phone number and an application off the roster", () => {
    for (const key of ["whatsapp", "intake_form_url", "personal_circumstances"]) {
      expect(adminBotMemberFieldVisibility(key), key).toBe("self");
    }
  });

  it("leaves the correspondence address lab-visible, because members write to it", () => {
    // A member composing a coauthor email reads this off the roster; making it self-only would
    // silently downgrade those to the directory address instead of failing visibly.
    expect(adminBotMemberFieldVisibility("correspondence_email")).toBe("lab");
  });

  it("agrees with what the boundary actually strips", () => {
    // The label a member reads and the rule the service enforces are one list, so the form cannot
    // promise something the redaction does not do.
    for (const key of adminBotConfidentialMemberFields) {
      expect(adminBotMemberFieldVisibility(key)).toBe("self");
    }
  });

  it("strips the private answers from another member's view of the record", () => {
    const seen = redactConfidentialMemberFields(member, {
      memberId: "ada",
      isAdmin: false,
      isMemberSession: true,
    });
    expect(seen.whatsapp).toBeUndefined();
    expect(seen.intake_form_url).toBeUndefined();
    expect(seen.personal_circumstances).toBeUndefined();
    // Deleted, not blanked: an empty string would tell the reader this person has nothing to
    // declare, which is itself a disclosure.
    expect("whatsapp" in seen).toBe(false);
    // ...and the roster is still a roster.
    expect(seen.github_url).toBe("https://github.com/mei");
    expect(seen.openreview_id).toBe("~Mei_Chen1");
    expect(seen.correspondence_email).toBe("mei@example.com");
  });

  it("shows a member their own record whole, and an admin everyone's", () => {
    const own = redactConfidentialMemberFields(member, {
      memberId: "mei",
      isAdmin: false,
      isMemberSession: true,
    });
    expect(own.whatsapp).toBe("+1 555 0100");
    const admin = redactConfidentialMemberFields(member, {
      memberId: "ada",
      isAdmin: true,
      isMemberSession: true,
    });
    expect(admin.intake_form_url).toBe("https://forms.google.com/response");
  });
});
