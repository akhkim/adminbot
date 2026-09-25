import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeClassification,
  calendarCommandRefusal,
  formatTalkLatex,
  outcomeLabelChange,
  resolveEmailAutomationSlackAccount,
  StateStore,
  type EmailMessage,
} from "../../scripts/adminbot-email-automation.js";
import type { ModelClassification } from "../../scripts/adminbot-email-model.js";
import type { OpenClawConfig } from "../../src/config/types/openclaw.js";

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  id: "m1",
  threadId: "t1",
  from: "student@example.com",
  fromName: "Genis Example",
  subject: "Research opportunity",
  body: "I would like to join your lab for a research opportunity.",
  ...overrides,
});

const classification = (
  overrides: Partial<ModelClassification> = {},
): ModelClassification => ({
  category: "student_reachout",
  confidence: 0.98,
  reason: "student asks to join the lab",
  decision: null,
  candidateEmail: null,
  candidateName: null,
  ...overrides,
});

// The privileged-sender allowlist is deployment configuration; without it nobody is privileged.
// Set here so the authorization tests exercise a configured deployment.
//
// Per test, not once: the vitest config restores stubbed env between tests, so a `beforeAll` stub
// was in place for the first test in the file and gone for every one after it. That is what the
// long-standing onboarding failure in this file actually was -- an unconfigured deployment, where
// `pi@example.edu` is nobody in particular.
beforeEach(() => {
  vi.stubEnv(
    "ADMINBOT_ONBOARDING_SENDERS",
    "pi@example.edu,pi.admin@example.edu",
  );
  vi.stubEnv("ADMINBOT_CONTACT_EMAILS", "ops@example.com");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("adminbot email automation", () => {
  // The thread is the identifier, not the address. These threads are ones AdminBot opened with one
  // candidate, so a reply on one is that candidate's -- and holding it for review because they
  // replied from Gmail, or from the new university account the thread is about, was most of what
  // the review queue actually contained.
  it("accepts an onboarding follow-up that arrives from another address on the tracked thread", () => {
    const tracked = { candidate_email: "Candidate@Example.edu", decision: "accept" as const };
    const authorized = authorizeClassification(
      message({ from: "candidate.personal@gmail.com" }),
      classification({ category: "onboarding_followup", confidence: 0.95 }),
      tracked,
    );
    expect(authorized.category).toBe("onboarding_followup");
    expect(authorized.decision).toBe("accept");
    // Bound to the candidate the thread names, never to the address that happened to send it.
    expect(authorized.candidateEmail).toBe("candidate@example.edu");
    expect(authorized.reason).toContain("candidate.personal@gmail.com");
  });

  it("still refuses an onboarding follow-up with no tracked thread to bind it to", () => {
    const authorized = authorizeClassification(
      message({ from: "someone@example.com" }),
      classification({ category: "onboarding_followup", confidence: 0.95 }),
    );
    expect(authorized.category).toBe("unknown");
    expect(authorized.reason).toContain("matched no tracked onboarding thread");
  });

  // Trust widened past the confidence gate for the two categories whose worst outcome is a row
  // somebody deletes, so the people who configured the deployment stop reviewing their own notes.
  it("takes a shaky talk entry from a lab address at its word", () => {
    const shaky = classification({ category: "talk_entry", confidence: 0.4 });
    expect(
      authorizeClassification(message({ from: "pi@example.edu" }), shaky).category,
    ).toBe("talk_entry");
    // Same read from a stranger still waits for a human.
    expect(
      authorizeClassification(message({ from: "stranger@example.com" }), shaky).category,
    ).toBe("unknown");
  });

  // Forwarding is how these tasks arrive -- a seminar announcement, a receipt -- so a forward from
  // a lab address is the request, not a reason to doubt it. What bounds the risk is the effect:
  // creation only for the calendar, and a reimbursement package that lands in the lab's own admin
  // inbox with the signature fields left blank.
  it("acts on a forwarded calendar or reimbursement task from a lab address", () => {
    for (const category of ["calendar_event", "reimbursement"] as const) {
      const shaky = classification({ category, confidence: 0.4 });
      expect(
        authorizeClassification(
          message({ from: "pi@example.edu", subject: "Fwd: seminar next week" }),
          shaky,
        ).category,
      ).toBe(category);
      expect(
        authorizeClassification(
          message({
            from: "pi@example.edu",
            subject: "receipts",
            body: "---------- Forwarded message ---------\nFrom: vendor@elsewhere.org\nInvoice attached.",
          }),
          shaky,
        ).category,
      ).toBe(category);
    }
  });

  // The sender is still the whole authority. A forward from outside is not a way in.
  it("still refuses the same forwarded task from a stranger", () => {
    for (const category of ["calendar_event", "reimbursement", "talk_entry"] as const) {
      expect(
        authorizeClassification(
          message({ from: "stranger@example.com", subject: "Fwd: seminar next week" }),
          classification({ category, confidence: 0.4 }),
        ).category,
      ).toBe("unknown");
    }
  });

  it("accepts high-confidence student outreach for LLM-guided handling", () => {
    expect(authorizeClassification(message(), classification()).category).toBe(
      "student_reachout",
    );
  });

  it("requires the real sender and complete model extraction for onboarding", () => {
    const direct = classification({
      category: "onboarding_instruction",
      reason: "accept directly",
      decision: "direct",
      candidateEmail: "candidate@example.com",
      candidateName: "Candidate",
    });
    expect(authorizeClassification(message(), direct).category).toBe("unknown");
    expect(
      authorizeClassification(message({ from: "pi@example.edu" }), direct),
    ).toMatchObject({
      category: "onboarding_instruction",
      decision: "direct",
      candidateEmail: "candidate@example.com",
    });
    expect(
      authorizeClassification(message({ from: "ops@example.com" }), direct)
        .category,
    ).toBe("unknown");
  });

  it("recognizes only tracked candidate followups", () => {
    const followup = classification({
      category: "onboarding_followup",
      reason: "candidate supplied a department email",
      decision: null,
      candidateEmail: "candidate@cs.toronto.edu",
    });
    expect(
      authorizeClassification(
        message({ from: "candidate@example.com" }),
        followup,
        {
          candidate_email: "candidate@example.com",
          decision: "direct",
        },
      ),
    ).toMatchObject({
      category: "onboarding_followup",
      decision: "direct",
      candidateEmail: "candidate@example.com",
    });
    expect(authorizeClassification(message(), followup).category).toBe(
      "unknown",
    );
  });

  it("rejects low-confidence and unauthorized privileged classifications", () => {
    expect(
      authorizeClassification(message(), classification({ confidence: 0.79 }))
        .category,
    ).toBe("unknown");
    expect(
      authorizeClassification(
        message(),
        classification({
          category: "calendar_event",
          reason: "calendar request",
        }),
      ).category,
    ).toBe("unknown");
  });

  it("takes a calendar request from a configured sender at its word, however sure the model was", () => {
    const hedged = classification({
      category: "calendar_event",
      confidence: 0.42,
      reason: "reads like a request to put a talk on the calendar",
    });
    expect(
      authorizeClassification(message({ from: "pi@example.edu" }), hedged)
        .category,
    ).toBe("calendar_event");
    expect(
      authorizeClassification(
        message({ from: "Ops <ops@example.com>" }),
        hedged,
      ).category,
    ).toBe("calendar_event");
    // The bypass is the sender's, not the category's: the same hedged read from outside is still
    // held for a person.
    expect(authorizeClassification(message(), hedged).category).toBe("unknown");
    // Reimbursement used to be excluded here, on the reading that a hedged classification meant
    // forms built from an email nobody was sure about. It is included now: the package it produces
    // is mailed to the lab's own admin with the funding-source and signature fields deliberately
    // blank, so a person handles it before it reaches anyone -- and the extraction checks in
    // prepareReimbursement, which are about the figures rather than the sender, still hold an
    // incomplete one back. The category being wrong costs one ignored draft in your own inbox.
    expect(
      authorizeClassification(
        message({ from: "pi@example.edu" }),
        classification({
          category: "reimbursement",
          confidence: 0.42,
          reason: "maybe expenses",
        }),
      ).category,
    ).toBe("reimbursement");
  });

  it("refuses any calendar command that is not a create or a read", () => {
    expect(
      calendarCommandRefusal(["calendar", "create", "lab@example.com"]),
    ).toBeUndefined();
    expect(calendarCommandRefusal(["calendar", "list"])).toBeUndefined();
    expect(
      calendarCommandRefusal(["calendar", "acl", "insert"]),
    ).toBeUndefined();
    expect(
      calendarCommandRefusal([
        "gmail",
        "messages",
        "modify",
        "--remove",
        "INBOX",
      ]),
    ).toBe(undefined);
    for (const args of [
      ["calendar", "delete", "lab@example.com", "evt1"],
      ["calendar", "remove", "evt1"],
      ["calendar", "update", "evt1"],
      ["calendar", "events", "delete", "evt1"],
      ["calendar", "acl", "delete", "someone@example.com"],
      ["calendar"],
    ]) {
      expect(calendarCommandRefusal(args)).toMatch(/never delete or modify/u);
    }
  });

  it("resolves env-backed Slack SecretRefs before standalone token reads", async () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: {
                source: "env",
                provider: "default",
                id: "SLACK_BOT_TOKEN",
              },
              userToken: {
                source: "env",
                provider: "default",
                id: "SLACK_USER_TOKEN",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = await resolveEmailAutomationSlackAccount({
      cfg,
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: "xoxb-resolved-bot-token",
        SLACK_USER_TOKEN: "xoxp-resolved-user-token",
      },
    });

    expect(account.botToken).toBe("xoxb-resolved-bot-token");
    expect(account.userToken).toBe("xoxp-resolved-user-token");
  });

  it("formats the requested CV talk LaTex structure", () => {
    expect(
      formatTalkLatex({
        title: "Emergent AI Safety Risks in Multi-Agent LLMs",
        venue:
          "Invited Keynote at the Cooperative AI Foundation Summer School 2026",
        location: "Toronto, Canada",
        date: "2026/8/3-4",
        upcoming: true,
      }),
    ).toBe(
      "\\item \\cvtalk{Emergent AI Safety Risks in Multi-Agent LLMs}{(Upcoming) Invited Keynote at the Cooperative AI Foundation Summer School 2026, Toronto, Canada}{2026/8/3-4}",
    );
  });

  describe("outcomeLabelChange", () => {
    it("files a handled message out of the inbox", () => {
      const change = outcomeLabelChange("completed");
      expect(change.add).toEqual(["AdminBot/Handled"]);
      // The inbox is the to-do list: what the automation finished does not belong on it.
      expect(change.remove).toContain("INBOX");
    });

    it("leaves the ones needing a person in the inbox, labelled with why", () => {
      for (const outcome of ["needs_review", "failed"] as const) {
        const change = outcomeLabelChange(outcome);
        // This is the whole reason these are labels and not a trash call: a failure that was
        // deleted is a failure nobody ever acts on, and a failure left unlabelled in the inbox
        // looks exactly like mail that has not been processed yet.
        expect(change.remove).not.toContain("INBOX");
      }
      expect(outcomeLabelChange("needs_review").add).toEqual([
        "AdminBot/Needs Review",
      ]);
      expect(outcomeLabelChange("failed").add).toEqual(["AdminBot/Error"]);
    });

    it("clears the other two outcomes, so a retried message never carries both", () => {
      const change = outcomeLabelChange("completed");
      expect(change.remove).toContain("AdminBot/Error");
      expect(change.remove).toContain("AdminBot/Needs Review");
      expect(change.remove).not.toContain("AdminBot/Handled");
    });
  });
});

// The scan window is resumable now, so what it remembers is part of the contract: a pass that
// failed on something must not leave behind a watermark that carries the mailbox past it.
describe("mailbox scan watermark", () => {
  function store(): { state: StateStore; databasePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-scan-"));
    const databasePath = path.join(dir, "state.sqlite");
    const state = new StateStore(databasePath);
    return {
      state,
      databasePath,
      cleanup: () => {
        state.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("has nothing to resume from on a mailbox it has never read", () => {
    const { state, cleanup } = store();
    expect(state.scannedThrough()).toBeUndefined();
    cleanup();
  });

  it("moves forward and never back", () => {
    const { state, cleanup } = store();
    state.markScannedThrough(new Date("2026-07-18T12:00:00Z"));
    state.markScannedThrough(new Date("2026-07-18T09:00:00Z"));
    expect(state.scannedThrough()?.toISOString()).toBe(
      "2026-07-18T12:00:00.000Z",
    );
    cleanup();
  });

  it("does not rewind when another process advanced the watermark after an old read", () => {
    const { state, databasePath, cleanup } = store();
    const other = new StateStore(databasePath);
    try {
      state.markScannedThrough(new Date("2026-07-18T09:00:00Z"));
      vi.spyOn(state, "scannedThrough").mockReturnValue(new Date("2026-07-18T09:00:00Z"));
      other.markScannedThrough(new Date("2026-07-18T12:00:00Z"));
      state.markScannedThrough(new Date("2026-07-18T10:00:00Z"));
      expect(other.scannedThrough()?.toISOString()).toBe("2026-07-18T12:00:00.000Z");
    } finally {
      other.close();
      cleanup();
    }
  });

  it("reports a processing message across store connections", () => {
    const { state, databasePath, cleanup } = store();
    const other = new StateStore(databasePath);
    const input = message({ id: "shared" });
    const classification = { category: "unknown", reason: "test" };
    try {
      expect(state.begin(input, classification)).toBe(true);
      expect(other.hasInProgressMessages()).toBe(true);
      state.finish("shared", "completed");
      expect(other.hasInProgressMessages()).toBe(false);
    } finally {
      other.close();
      cleanup();
    }
  });

  it("treats a settled message as done and a retryable one as not", () => {
    const { state, cleanup } = store();
    state.begin(message({ id: "settled" }), {
      category: "unknown",
      reason: "test",
    });
    expect(state.isSettled("settled")).toBe(false);
    state.finish("settled", "completed");
    expect(state.isSettled("settled")).toBe(true);
    state.begin(message({ id: "broke" }), {
      category: "unknown",
      reason: "test",
    });
    state.finish("broke", "failed", "boom");
    expect(state.isSettled("broke")).toBe(false);
    expect(
      state.begin(message({ id: "broke" }), { category: "unknown", reason: "retry" }),
    ).toBe(true);
    expect(state.isSettled("never-seen")).toBe(false);
    cleanup();
  });

  it("stores the subject and received time an administrator needs to review the message", () => {
    const { state, cleanup } = store();
    state.begin(
      message({
        id: "held",
        subject: "Reviews released",
        internalDate: String(Date.parse("2026-09-03T21:04:00.000Z")),
      }),
      {
        category: "paperflow_bcc",
        reason: "sender is not a trusted lab address",
      },
    );
    state.finish("held", "needs_review", "sender is not a trusted lab address");

    expect(
      state.db
        .prepare(
          "SELECT subject, received_at, status FROM adminbot_email_messages WHERE message_id = ?",
        )
        .get("held"),
    ).toEqual({
      subject: "Reviews released",
      received_at: "2026-09-03T21:04:00.000Z",
      status: "needs_review",
    });
    cleanup();
  });
});

describe("email automation claims", () => {
  it("allows only one run to claim an interleaved message", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-email-claim-"));
    const databasePath = path.join(dir, "state.sqlite");
    const first = new StateStore(databasePath);
    const second = new StateStore(databasePath);
    const item = message({ id: "race" });
    const kind = { category: "student_reachout", reason: "test" };
    let competingClaim: boolean | undefined;
    const prepare = first.db.prepare.bind(first.db);
    vi.spyOn(first.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (String(sql).includes("SELECT status FROM adminbot_email_messages WHERE message_id")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args) => {
          const row = get(...args);
          competingClaim = second.begin(item, kind);
          return row;
        });
      }
      return statement;
    });
    try {
      const firstClaim = first.begin(item, kind);
      const secondClaim = competingClaim ?? second.begin(item, kind);
      expect(Number(firstClaim) + Number(secondClaim)).toBe(1);
    } finally {
      first.close();
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts an external effect only once when two runs interleave", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-email-effect-"));
    const databasePath = path.join(dir, "state.sqlite");
    const first = new StateStore(databasePath);
    const second = new StateStore(databasePath);
    let executions = 0;
    let competingEffect: Promise<string | undefined> | undefined;
    const operation = async () => {
      executions += 1;
      return "sent";
    };
    const prepare = first.db.prepare.bind(first.db);
    vi.spyOn(first.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (String(sql).includes("SELECT status, result_json FROM adminbot_email_effects")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args) => {
          const row = get(...args);
          competingEffect = second.effect("race", "send", operation);
          return row;
        });
      }
      return statement;
    });
    try {
      const firstEffect = first.effect("race", "send", operation);
      competingEffect ??= second.effect("race", "send", operation);
      const results = await Promise.allSettled([firstEffect, competingEffect]);
      expect(executions).toBe(1);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(await second.effect("race", "send", operation)).toBe("sent");
      expect(executions).toBe(1);
    } finally {
      first.close();
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
