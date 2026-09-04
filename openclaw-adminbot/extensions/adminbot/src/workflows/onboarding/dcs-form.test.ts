import { describe, expect, it, vi } from "vitest";
import { createMemoryFailedRequestLedger } from "../../persistence/failed-requests.js";
import { splitDisplayName, submitDcsFormViaAwsFallback, withDcsFormFailover } from "./dcs-form.js";

// The roster keeps one free-text name; the DCS form wants First and Last as separate required
// answers. These cases moved here with the splitter itself, which used to live on the approval
// path that filed the request.
describe("splitDisplayName", () => {
  it("splits an ordinary name at the space", () => {
    expect(splitDisplayName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  // Both fields are required, so a one-word name fills them both rather than leaving one blank
  // and having the form refuse the submission.
  it("uses a one-word name for both first and last name", () => {
    expect(splitDisplayName("Cher")).toEqual({ firstName: "Cher", lastName: "Cher" });
  });

  // The split is on the *last* space: a middle name belongs with the first name, and reading it as
  // a surname would file the request under the wrong one.
  it("keeps a middle name with the first name, not the last", () => {
    expect(splitDisplayName("Mary Jane Watson")).toEqual({
      firstName: "Mary Jane",
      lastName: "Watson",
    });
  });

  it("ignores surrounding whitespace", () => {
    expect(splitDisplayName("  Ada Lovelace  ")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });
});

describe("withDcsFormFailover", () => {
  const params = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" };

  it("records the exact payload, retries over AWS, then escalates", async () => {
    const ledger = createMemoryFailedRequestLedger();
    const escalate = vi.fn(async () => ({ escalated: true as const }));
    const wrapped = withDcsFormFailover(
      async () => {
        throw new Error("playwright hung");
      },
      {
        record: (input) => ledger.record(input),
        update: (id, patch) => ledger.update(id, patch)!,
        awsFallback: async () => {
          throw new Error("lambda 503");
        },
        escalateToHumans: escalate,
      },
    );
    await expect(wrapped(params)).rejects.toThrow("playwright hung");
    const [row] = ledger.list();
    expect(row).toMatchObject({
      service_type: "dcs_form",
      payload: params,
      status: "escalated_to_human",
      attempt_count: 2,
    });
    expect(escalate).toHaveBeenCalledOnce();
    expect(escalate.mock.calls[0]?.[0]).toMatchObject({
      params,
      error: "playwright hung",
      recordId: row!.id,
    });
  });

  it("marks the ledger resolved when AWS fallback succeeds", async () => {
    const ledger = createMemoryFailedRequestLedger();
    const wrapped = withDcsFormFailover(
      async () => {
        throw new Error("form changed");
      },
      {
        record: (input) => ledger.record(input),
        update: (id, patch) => ledger.update(id, patch)!,
        awsFallback: async () => {},
      },
    );
    await wrapped(params);
    expect(ledger.list()[0]).toMatchObject({ status: "resolved", attempt_count: 2 });
  });

  it("does not claim human escalation when no nudge was delivered", async () => {
    const ledger = createMemoryFailedRequestLedger();
    const wrapped = withDcsFormFailover(
      async () => {
        throw new Error("playwright hung");
      },
      {
        record: (input) => ledger.record(input),
        update: (id, patch) => ledger.update(id, patch)!,
        awsFallback: async () => {
          throw new Error("lambda 503");
        },
        escalateToHumans: async () => ({
          escalated: false,
          errorMessage: "no DCS escalation recipients are configured",
        }),
      },
    );

    await expect(wrapped(params)).rejects.toThrow("playwright hung");
    expect(ledger.list()[0]).toMatchObject({
      status: "aws_retry_failed",
      attempt_count: 2,
      error_message:
        "playwright hung; aws: lambda 503; escalation: no DCS escalation recipients are configured",
    });
  });
});

describe("submitDcsFormViaAwsFallback", () => {
  it("refuses a non-https remote URL", async () => {
    await expect(
      submitDcsFormViaAwsFallback(
        { firstName: "A", lastName: "B", email: "a@b.co" },
        { url: "http://example.com/dcs" },
      ),
    ).rejects.toThrow("https");
  });
});
