// The pre-submission gate: that it fails closed, that the two funders get different rules, and
// that a verdict never disagrees with its own findings.
import { describe, expect, it } from "vitest";
import {
  adminBotReimbursementRules,
  emptyReimbursementEvidence,
  rulesForFunder,
  type AdminBotReimbursementEvidence,
} from "../../contracts/reimbursement-rules.js";
import { checkReimbursementPackage, describeCheck } from "./check.js";

const NOW = new Date("2026-09-10T00:00:00.000Z");

/** Everything positively established, nothing triggered. The one shape that clears the gate. */
function cleanEvidence(
  overrides: Partial<AdminBotReimbursementEvidence> = {},
): AdminBotReimbursementEvidence {
  return {
    ...emptyReimbursementEvidence(),
    form_signed: true,
    business_purpose_per_item: true,
    unclaimed_sections_cleared: true,
    personally_incurred: true,
    receipts_ordered: true,
    // DCS
    dcs_forms_complete: true,
    trip_end_date: "2026-09-01",
    payment_address_confirmed: true,
    institutional_email: true,
    finance_contact_available: true,
    // MPI IS
    private_address_matches_bank: true,
    reason_for_refund_stated: true,
    all_amounts_in_eur: true,
    card_statement_attached: true,
    receipts_attached_as_files: true,
    director_email_forwarded: true,
    supervisor_justification_attached: true,
    guest_signature_and_date: true,
    director_approved_before_trip: true,
    ...overrides,
  };
}

describe("the registry", () => {
  it("gives every rule an evaluator, so nothing passes by not being implemented", () => {
    // A rule with no evaluator reports itself as a blocker; this asserts none does.
    for (const funder of ["DCS", "MPI-IS"] as const) {
      const check = checkReimbursementPackage({
        funder,
        evidence: cleanEvidence(),
        now: NOW,
      });
      const unimplemented = check.blockers.filter((finding) =>
        finding.detail.includes("no evaluator"),
      );
      expect(unimplemented, `${funder}: ${unimplemented.map((f) => f.rule_id).join(", ")}`).toEqual(
        [],
      );
    }
  });

  it("keeps the funder-specific rules apart, because they contradict each other", () => {
    const dcs = rulesForFunder("DCS").map((rule) => rule.id);
    const mpi = rulesForFunder("MPI-IS").map((rule) => rule.id);
    // R-MPI.5 requires a card statement; R-DCS.9 says never to ask for one. Applying one funder's
    // set to the other's package is the failure R0.2 exists to prevent.
    expect(mpi).toContain("R-MPI.5");
    expect(dcs).not.toContain("R-MPI.5");
    expect(dcs).toContain("R-DCS.2");
    expect(mpi).not.toContain("R-DCS.2");
  });

  it("carries every rule id from the ruleset document", () => {
    const ids = new Set(adminBotReimbursementRules.map((rule) => rule.id));
    for (const id of [
      "R0.1",
      "R1.1",
      "R1.2",
      "R1.12",
      "R2.1",
      "R2.6",
      "R3.1",
      "R3.5",
      "R-DCS.1",
      "R-DCS.3",
      "R-MPI.1",
      "R-MPI.11",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe("the funder gate", () => {
  it("refuses everything until an institute is chosen", () => {
    const check = checkReimbursementPackage({ evidence: cleanEvidence(), now: NOW });
    expect(check.verdict).toBe("do_not_submit");
    expect(check.blockers.map((finding) => finding.rule_id)).toEqual(["R0.1"]);
    // And says nothing about the other rules: with no funder there is no ruleset to apply.
    expect(check.warnings).toEqual([]);
  });
});

describe("failing closed", () => {
  it("clears a complete package", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence(),
      now: NOW,
    });
    expect(check.blockers).toEqual([]);
    expect(check.verdict).toBe("ready_to_submit");
  });

  it("treats an unanswered flag as a failure, not as a pass", () => {
    // The whole design: absent means nobody established it, and that is not the same as fine.
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: { ...cleanEvidence(), form_signed: undefined },
      now: NOW,
    });
    expect(check.verdict).toBe("do_not_submit");
    expect(check.blockers.map((finding) => finding.rule_id)).toContain("R1.1");
  });

  it("says nothing about a rule whose trigger is absent", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence(),
      now: NOW,
    });
    // No accommodation claimed, so the folio rule is silent rather than failing.
    expect(check.blockers.map((finding) => finding.rule_id)).not.toContain("R1.2");
    expect(check.warnings.map((finding) => finding.rule_id)).not.toContain("R1.2");
  });

  it("demands a folio the moment accommodation is claimed", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({ claims_accommodation: true }),
      now: NOW,
    });
    expect(check.blockers.map((finding) => finding.rule_id)).toContain("R1.2");
  });

  it("never lets the verdict disagree with its own findings", () => {
    const check = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: cleanEvidence({ card_statement_attached: undefined }),
      now: NOW,
    });
    expect(check.blockers.length).toBeGreaterThan(0);
    expect(check.verdict).toBe("do_not_submit");
  });

  it("allows submission with warnings outstanding", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({ receipts_ordered: false }),
      now: NOW,
    });
    expect(check.warnings.map((finding) => finding.rule_id)).toContain("R1.11");
    // A warning that stopped submission would make the check worse than useless.
    expect(check.verdict).toBe("ready_to_submit");
  });
});

describe("amount reconciliation", () => {
  it("blocks on a line that does not reconcile and names it", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({
        amounts: [
          { label: "Flight CHF 1174.80", reconciled: true, date: "2026-06-09" },
          { label: "Hotel EUR 612", reconciled: false, note: "no folio attached" },
        ],
      }),
      now: NOW,
    });
    const finding = check.blockers.find((entry) => entry.rule_id === "R1.4");
    expect(finding?.detail).toContain("Hotel EUR 612");
    // Every line is reported either way, per the amounts-checked section.
    expect(check.amounts_checked).toHaveLength(2);
    expect(check.amounts_checked[1]?.note).toBe("no folio attached");
  });
});

describe("DCS date windows", () => {
  it("blocks a transaction two years or older", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({
        amounts: [{ label: "Old flight", reconciled: true, date: "2024-01-01" }],
      }),
      now: NOW,
    });
    expect(check.blockers.map((finding) => finding.rule_id)).toContain("R-DCS.3");
  });

  it("warns on a transaction between one and two years old, without blocking", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({
        amounts: [{ label: "Last year's flight", reconciled: true, date: "2025-06-01" }],
      }),
      now: NOW,
    });
    expect(check.warnings.map((finding) => finding.rule_id)).toContain("R-DCS.4");
    expect(check.verdict).toBe("ready_to_submit");
  });

  it("blocks a trip that ended past the three-working-week deadline", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({ trip_end_date: "2026-07-01" }),
      now: NOW,
    });
    expect(check.blockers.map((finding) => finding.rule_id)).toContain("R-DCS.2");
  });

  it("blocks when no trip end date is known, rather than assuming it is in time", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({ trip_end_date: undefined }),
      now: NOW,
    });
    expect(check.blockers.map((finding) => finding.rule_id)).toContain("R-DCS.2");
  });
});

describe("unrecoverable findings", () => {
  it("surfaces the business-portion quote separately, because it cannot be reconstructed", () => {
    const check = checkReimbursementPackage({
      funder: "DCS",
      evidence: cleanEvidence({ mixed_personal_business: true }),
      now: NOW,
    });
    const ids = check.unrecoverable.map((finding) => finding.rule_id);
    expect(ids).toContain("R2.1");
    // It is a blocker too; the separate list is about what decision it forces, not its severity.
    expect(check.blockers.map((finding) => finding.rule_id)).toContain("R2.1");
    expect(describeCheck(check)).toContain("cannot be fixed after the fact");
  });
});

describe("MPI IS specifics", () => {
  it("requires oanda conversions only when something was not in EUR", () => {
    const without = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: cleanEvidence(),
      now: NOW,
    });
    expect(without.blockers.map((finding) => finding.rule_id)).not.toContain("R-MPI.4");
    const with_ = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: cleanEvidence({ has_non_eur_amounts: true }),
      now: NOW,
    });
    expect(with_.blockers.map((finding) => finding.rule_id)).toContain("R-MPI.4");
  });

  it("checks the cap only when the director set one", () => {
    const uncapped = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: cleanEvidence(),
      now: NOW,
    });
    expect(uncapped.blockers.map((finding) => finding.rule_id)).not.toContain("R-MPI.7");
    const capped = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: cleanEvidence({ director_cap_amount: 1500 }),
      now: NOW,
    });
    expect(capped.blockers.map((finding) => finding.rule_id)).toContain("R-MPI.7");
  });

  it("never asks an MPI claim for the DCS forms, or a DCS claim for a card statement", () => {
    const mpi = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: { ...cleanEvidence(), dcs_forms_complete: undefined },
      now: NOW,
    });
    expect(mpi.blockers.map((finding) => finding.rule_id)).not.toContain("R-DCS.1");
    const dcs = checkReimbursementPackage({
      funder: "DCS",
      evidence: { ...cleanEvidence(), card_statement_attached: undefined },
      now: NOW,
    });
    expect(dcs.blockers.map((finding) => finding.rule_id)).not.toContain("R-MPI.5");
  });
});

describe("describeCheck", () => {
  it("always states why nothing was generated", () => {
    const check = checkReimbursementPackage({
      funder: "MPI-IS",
      evidence: emptyReimbursementEvidence(),
      now: NOW,
    });
    const line = describeCheck(check);
    expect(line).toContain("Do not submit");
    expect(line).toContain("No forms were generated");
  });
});
