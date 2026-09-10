// Whether a prepared package may be submitted, decided from evidence flags rather than by a model.
//
// The split matters. Reading a hotel folio out of a PDF and deciding whether it is a folio or a
// booking confirmation is extraction, and a model is good at it. Deciding whether the resulting
// package clears thirty-odd finance rules is arithmetic over those answers, and a model is a bad
// place to put arithmetic that has to give the same answer twice. So the conversation fills in
// `AdminBotReimbursementEvidence` and this file walks the registry over it.
//
// Everything here is fail-closed. An evidence flag that is `undefined` -- because nobody asked,
// because the model could not tell, because the field is new and the stored draft predates it --
// counts as not satisfied. The alternative, treating unknown as fine, produces exactly the
// outcome the ruleset exists to prevent: a package that passes the check and comes back six weeks
// later from the finance office.

import {
  rulesForFunder,
  type AdminBotReimbursementCheck,
  type AdminBotReimbursementEvidence,
  type AdminBotReimbursementFinding,
  type AdminBotReimbursementFunder,
  type AdminBotReimbursementRule,
} from "../../contracts/reimbursement-rules.js";

/** Milliseconds in a day, for the two DCS date windows. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Three working weeks, the DCS deadline in R-DCS.2. Weekends make this 21 calendar days plus. */
const DCS_DEADLINE_DAYS = 21;

function days(from: string | undefined, to: Date): number | undefined {
  if (!from) {
    return undefined;
  }
  const at = Date.parse(from);
  return Number.isFinite(at) ? (to.getTime() - at) / DAY_MS : undefined;
}

/**
 * One rule's verdict on this package.
 *
 * `undefined` means the rule does not apply -- its trigger is absent -- which is different from
 * passing and different from failing. A rule that does not apply produces no finding at all.
 */
type Outcome = { failed: boolean; detail: string } | undefined;

function fails(detail: string): Outcome {
  return { failed: true, detail };
}

const PASSES: Outcome = { failed: false, detail: "" };

/**
 * Every rule's evaluator, keyed by id.
 *
 * Written as a lookup rather than a chain of ifs so a rule in the registry with no evaluator is a
 * visible hole rather than a silent pass -- `evaluate` reports one as a blocker naming itself.
 */
const EVALUATORS: Record<string, (evidence: AdminBotReimbursementEvidence, now: Date) => Outcome> =
  {
    "R0.1": (e) => (e.funder ? PASSES : fails("No reimbursement institute has been chosen.")),
    "R0.3": (e) =>
      e.grant_restricted
        ? e.grant_category_open
          ? PASSES
          : fails(
              "The expense is grant-restricted and nobody has confirmed the category is still open.",
            )
        : undefined,

    "R1.1": (e) =>
      e.form_signed ? PASSES : fails("The claimant section is incomplete or unsigned."),
    "R1.2": (e) =>
      e.claims_accommodation
        ? e.accommodation_folio_attached
          ? PASSES
          : fails("An accommodation line is claimed with no detailed check-out folio attached.")
        : undefined,
    "R1.3": (e) =>
      e.claims_air_or_rail
        ? e.travel_occurred_evidence
          ? PASSES
          : fails("A fare is claimed with nothing showing the travel happened.")
        : undefined,
    "R1.4": (e) => {
      const unreconciled = e.amounts.filter((amount) => !amount.reconciled);
      return unreconciled.length === 0
        ? PASSES
        : fails(
            `${unreconciled.length} amount(s) do not reconcile against an attached document: ${unreconciled
              .map((amount) => amount.label)
              .join(", ")}.`,
          );
    },
    "R1.5": (e) =>
      e.business_purpose_per_item
        ? PASSES
        : fails("At least one line has no business purpose an auditor could follow."),
    "R1.6": (e) =>
      e.claims_meals_or_hospitality
        ? e.attendees_per_receipt
          ? PASSES
          : fails("A meal or hospitality receipt has no named attendee list of its own.")
        : undefined,
    "R1.7": (e) =>
      e.claims_per_diem
        ? e.per_diem_not_covered_elsewhere
          ? PASSES
          : fails(
              "A per diem is claimed and nobody has confirmed the meal was not already covered by the hotel rate or the conference agenda.",
            )
        : undefined,
    "R1.8": (e) =>
      e.unclaimed_sections_cleared
        ? PASSES
        : fails("A section that is not being claimed still carries a calculated value."),
    "R1.9": (e) =>
      e.personally_incurred
        ? PASSES
        : fails("At least one expense was paid on an instrument that is not the claimant's."),
    "R1.10": (e) =>
      e.evidence_by_link
        ? e.links_verified_logged_out
          ? PASSES
          : fails(
              "Evidence is linked rather than attached and the links have not been checked logged out.",
            )
        : undefined,
    "R1.11": (e) =>
      e.receipts_ordered
        ? PASSES
        : fails("Receipts are not ordered and numbered to match the form."),
    "R1.12": (e) =>
      e.non_reimbursable_items.length === 0
        ? PASSES
        : fails(
            `The claim contains non-reimbursable items: ${e.non_reimbursable_items.join(", ")}.`,
          ),

    "R2.1": (e) =>
      e.mixed_personal_business
        ? e.business_portion_quote_at_booking
          ? PASSES
          : fails(
              "Personal and business travel are combined with no business-only fare quote captured at booking time.",
            )
        : undefined,
    "R2.2": (e) =>
      e.mixed_personal_business && e.business_portion_quote_at_booking
        ? e.quote_and_invoice_comparable
          ? PASSES
          : fails(
              "The business-only quote and the booking invoice are not from the same date and conditions.",
            )
        : undefined,
    "R2.3": (e) =>
      e.has_legs_away_from_home
        ? e.purpose_per_leg
          ? PASSES
          : fails(
              "A leg does not start or end at the home address and has no business purpose of its own.",
            )
        : undefined,
    "R2.4": (e) =>
      e.trip_extends_beyond_event
        ? e.no_personal_day_claims
          ? PASSES
          : fails("Accommodation or meals are claimed for days outside the eligible event window.")
        : undefined,
    "R2.5": (e) =>
      e.mixed_personal_business
        ? e.approver_notified_before_booking
          ? PASSES
          : fails(
              "No written evidence that the approver knew about the combined trip before booking.",
            )
        : undefined,
    "R2.6": (e) =>
      e.premium_cabin
        ? e.premium_pre_authorised
          ? PASSES
          : fails(
              "A fare above least-expensive economy is claimed with no dated pre-authorisation.",
            )
        : undefined,
    "R2.7": (e) =>
      e.claims_air_or_rail
        ? e.booked_14_days_ahead
          ? PASSES
          : fails("The fare was booked less than 14 days before departure.")
        : undefined,

    "R3.1": (e) =>
      e.accommodation_booked_for_others
        ? e.accommodation_payer_seniority_ok
          ? PASSES
          : fails("Accommodation was paid for somebody more senior than the payer.")
        : undefined,
    "R3.3": (e) =>
      e.accommodation_shared
        ? e.accommodation_payer_seniority_ok
          ? PASSES
          : fails("Shared accommodation is not on the most senior occupant's card.")
        : undefined,
    "R3.4": (e) =>
      e.claims_air_or_rail
        ? e.airfare_self_purchased
          ? PASSES
          : fails("Airfare was purchased for somebody other than the purchaser.")
        : undefined,
    "R3.5": (e) =>
      e.claims_group_meal
        ? e.group_meal_paid_by_senior
          ? PASSES
          : fails("A group meal including senior employees was paid by a junior member.")
        : undefined,

    "R-DCS.1": (e) =>
      e.dcs_forms_complete
        ? PASSES
        : fails("Not every form this claim requires has been produced."),
    "R-DCS.2": (e, now) => {
      const elapsed = days(e.trip_end_date, now);
      if (elapsed === undefined) {
        return fails(
          "No trip end date is recorded, so the 3-working-week deadline cannot be checked.",
        );
      }
      return elapsed <= DCS_DEADLINE_DAYS
        ? PASSES
        : fails(
            `The trip ended ${Math.floor(elapsed)} days ago, past the 3-working-week deadline.`,
          );
    },
    "R-DCS.3": (e, now) => {
      const stale = e.amounts.filter((amount) => {
        const age = days(amount.date, now);
        return age !== undefined && age >= 730;
      });
      return stale.length === 0
        ? PASSES
        : fails(
            `${stale.length} transaction(s) are two years or older and are not eligible: ${stale
              .map((amount) => amount.label)
              .join(", ")}.`,
          );
    },
    "R-DCS.4": (e, now) => {
      const ageing = e.amounts.filter((amount) => {
        const age = days(amount.date, now);
        return age !== undefined && age >= 365 && age < 730;
      });
      if (ageing.length === 0) {
        return undefined;
      }
      return e.old_transaction_justification
        ? PASSES
        : fails(
            `${ageing.length} transaction(s) are between 1 and 2 years old and carry no written justification.`,
          );
    },
    "R-DCS.5": (e) =>
      e.payment_address_confirmed
        ? PASSES
        : fails("Nobody has confirmed the form address is where payment should be delivered."),
    "R-DCS.6": (e) =>
      e.claims_registration
        ? e.registration_confirmation_and_payment
          ? PASSES
          : fails(
              "Conference registration is claimed without both the confirmation and proof of payment.",
            )
        : undefined,
    "R-DCS.7": (e) =>
      e.uses_missing_receipt_form
        ? e.missing_receipt_form_signed
          ? PASSES
          : fails("The Missing/Difficult to Receipt form is unsigned by the approver.")
        : undefined,
    "R-DCS.8": (e) =>
      e.split_funding
        ? e.split_funding_declared
          ? PASSES
          : fails(
              "The claim is split with another funder with no declaration that it was not claimed twice.",
            )
        : undefined,
    "R-DCS.10": (e) =>
      e.institutional_email
        ? PASSES
        : fails("The claim uses a personal email address rather than the institutional one."),
    "R-DCS.11": (e) =>
      e.finance_contact_available
        ? PASSES
        : fails("The finance contact may be on leave; the submission would sit unprocessed."),

    "R-MPI.1": (e) =>
      e.private_address_matches_bank
        ? PASSES
        : fails(
            "The form does not carry the claimant's private address matching the bank account.",
          ),
    "R-MPI.2": (e) =>
      e.reason_for_refund_stated
        ? PASSES
        : fails("The reason is not in the expected form: trip to [location] to present [what]."),
    "R-MPI.3": (e) =>
      e.all_amounts_in_eur ? PASSES : fails("Not every amount on the form is in EUR."),
    "R-MPI.4": (e) =>
      e.has_non_eur_amounts
        ? e.oanda_conversions_attached
          ? PASSES
          : fails("Non-EUR amounts are claimed with no oanda.com conversion PDFs attached.")
        : undefined,
    "R-MPI.5": (e) =>
      e.card_statement_attached
        ? PASSES
        : fails(
            "The credit card statement is not attached. MPI IS requires it as proof of payment.",
          ),
    "R-MPI.6": (e) =>
      e.receipts_attached_as_files
        ? PASSES
        : fails("Not every receipt is attached as a PDF or photo."),
    "R-MPI.7": (e) =>
      e.director_cap_amount !== undefined
        ? e.totals_within_cap
          ? PASSES
          : fails("The submitted totals do not add up to the approved maximum, or exceed it.")
        : undefined,
    "R-MPI.8": (e) =>
      e.director_email_forwarded
        ? PASSES
        : fails("The director's confirmation email has not been forwarded to the secretariat."),
    "R-MPI.9": (e) =>
      e.supervisor_justification_attached
        ? PASSES
        : fails(
            "The supervisor's justification text is missing. The claim cannot proceed without it.",
          ),
    "R-MPI.10": (e) =>
      e.guest_signature_and_date
        ? PASSES
        : fails("The form is not dated and signed at the guest's signature field."),
    "R-MPI.11": (e) =>
      e.director_approved_before_trip
        ? PASSES
        : fails("Director approval was not obtained before the trip. The claim rests on this."),
  };

function findingFor(rule: AdminBotReimbursementRule, detail: string): AdminBotReimbursementFinding {
  return {
    rule_id: rule.id,
    severity: rule.severity,
    title: rule.title,
    detail,
    remedy: rule.remedy,
    ...(rule.unrecoverable ? { unrecoverable: true } : {}),
  };
}

/**
 * Walk the funder's rules and produce the §6 report.
 *
 * The funder gates everything, per R0.1 and R0.2: with none chosen there is no ruleset to apply,
 * so the answer is one blocker saying so rather than a guess at which office is paying. The two
 * rulesets genuinely contradict each other -- MPI IS requires a card statement, DCS says never to
 * ask for one -- so applying the wrong one is not a near miss.
 */
export function checkReimbursementPackage(params: {
  funder?: AdminBotReimbursementFunder;
  evidence: AdminBotReimbursementEvidence;
  now?: Date;
}): AdminBotReimbursementCheck {
  const now = params.now ?? new Date();
  const evidence = { ...params.evidence, funder: params.funder ?? params.evidence.funder };
  const blockers: AdminBotReimbursementFinding[] = [];
  const warnings: AdminBotReimbursementFinding[] = [];

  if (!evidence.funder) {
    const rule = rulesForFunder("DCS").find((entry) => entry.id === "R0.1");
    return {
      verdict: "do_not_submit",
      blockers: rule ? [findingFor(rule, "No reimbursement institute has been chosen.")] : [],
      warnings: [],
      unrecoverable: [],
      amounts_checked: [],
    };
  }

  for (const rule of rulesForFunder(evidence.funder)) {
    const evaluator = EVALUATORS[rule.id];
    if (!evaluator) {
      // A registry entry with no evaluator is a hole in the check, and the honest thing is to say
      // so rather than let the package pass on a rule nobody implemented.
      blockers.push(
        findingFor(rule, "This rule has no evaluator, so the package cannot be cleared."),
      );
      continue;
    }
    const outcome = evaluator(evidence, now);
    if (!outcome || !outcome.failed) {
      continue;
    }
    (rule.severity === "blocker" ? blockers : warnings).push(findingFor(rule, outcome.detail));
  }

  return {
    funder: evidence.funder,
    // Derived, never set alongside the findings: a verdict that could disagree with its own list
    // is how a package gets waved through with a blocker still on it.
    verdict: blockers.length === 0 ? "ready_to_submit" : "do_not_submit",
    blockers,
    warnings,
    unrecoverable: blockers.filter((finding) => finding.unrecoverable),
    amounts_checked: evidence.amounts.map((amount) => ({
      label: amount.label,
      reconciled: amount.reconciled,
      ...(amount.note ? { note: amount.note } : {}),
    })),
  };
}

/** The one-line summary the assistant says back, so a refusal always states its own reason. */
export function describeCheck(check: AdminBotReimbursementCheck): string {
  if (check.verdict === "ready_to_submit") {
    return check.warnings.length
      ? `Ready to submit, with ${check.warnings.length} warning(s) worth fixing first.`
      : "Ready to submit.";
  }
  const unrecoverable = check.unrecoverable.length
    ? ` ${check.unrecoverable.length} of them cannot be fixed after the fact.`
    : "";
  return `Do not submit — ${check.blockers.length} blocker(s) outstanding.${unrecoverable} No forms were generated.`;
}
