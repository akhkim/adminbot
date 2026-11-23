// Public-to-lab vs private-to-self: which answers the roster serves to everyone, and which it does
// not. The roster loads whole records at sign-in, so a field on the record is readable in devtools
// by every member whatever the UI chooses to draw -- the redaction is the only thing that is real.
import { describe, expect, it } from "vitest";
import {
  adminBotConfidentialMemberFields,
  adminBotStaffOnlyMemberFields,
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

describe("owner-only member bookkeeping", () => {
  const record = {
    ...member,
    onboarding: { steps: [{ id: "linkedin", status: "complete" }] },
    field_provenance: { github_url: { source: "admin", at: "2026-01-01T00:00:00.000Z" } },
    access: [{ system: "slack", level: "member" }],
  };

  it("strips checklist progress, provenance and grants from a peer's view", () => {
    const seen = redactConfidentialMemberFields(record, {
      memberId: "ada",
      isAdmin: false,
      isMemberSession: true,
    });
    expect("onboarding" in seen).toBe(false);
    expect("field_provenance" in seen).toBe(false);
    expect("access" in seen).toBe(false);
    expect(seen.github_url).toBe("https://github.com/mei");
  });

  it("strips them for the service principal too, which no agent tool needs them for", () => {
    const seen = redactConfidentialMemberFields(record, { isAdmin: false });
    expect("onboarding" in seen).toBe(false);
    expect("field_provenance" in seen).toBe(false);
    expect("access" in seen).toBe(false);
  });

  it("keeps them for the member themselves and for an admin", () => {
    for (const viewer of [
      { memberId: "mei", isAdmin: false, isMemberSession: true },
      { memberId: "ada", isAdmin: true, isMemberSession: true },
    ]) {
      const seen = redactConfidentialMemberFields(record, viewer);
      expect(seen.onboarding).toEqual(record.onboarding);
      expect(seen.field_provenance).toEqual(record.field_provenance);
      expect(seen.access).toEqual(record.access);
    }
  });

  it("keeps admin notes, other addresses, login times and access switches off other members' view", () => {
    const record = {
      ...member,
      notes: "Admin note",
      alternate_emails: ["mei@old.example.com"],
      cv_snapshot: { hash: "x" },
      last_login_at: "2026-11-20T10:00:00Z",
      last_seen_at: "2026-11-20",
      compute_access: ["H100"],
      cli_role: "power_user",
      merch_requests: "M hoodie",
    };
    const seen = redactConfidentialMemberFields(record, {
      memberId: "ada",
      isAdmin: false,
      isMemberSession: true,
    }) as Record<string, unknown>;
    for (const key of adminBotStaffOnlyMemberFields) {
      expect(key in seen, key).toBe(false);
      expect(adminBotMemberFieldVisibility(key), key).toBe("self");
    }
    // Written for the lab to read, so it stays.
    expect(seen.merch_requests).toBe("M hoodie");
    // The AdminBot service still gets them: it does the work they exist for.
    const service = redactConfidentialMemberFields(record, { isAdmin: false }) as Record<
      string,
      unknown
    >;
    expect(service.notes).toBe("Admin note");
    const own = redactConfidentialMemberFields(record, {
      memberId: "mei",
      isAdmin: false,
      isMemberSession: true,
    }) as Record<string, unknown>;
    expect(own.notes).toBe("Admin note");
  });
});
