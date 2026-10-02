// The pre-submission ruleset, as data rather than as prose in a prompt.
//
// Every rule the finance offices apply has an id, a severity and a funder it belongs to, and the
// checker walks this registry. That shape is deliberate: a rule spelled out in a system prompt is
// a rule nobody can test, and the thing this whole check exists to prevent -- a package that comes
// back six weeks later for a missing document -- is exactly what a silently-drifting prompt
// produces. Each entry here is asserted against in reimbursement-rules.test.ts.
//
// The model's job is extraction, not judgement. It reads the receipts and the conversation and
// fills in the evidence flags below; whether those flags add up to a submittable package is
// decided here, deterministically, so the same inputs always produce the same verdict.
//
// Source: reimbursement_ruleset.md (UofT DCS & MPI IS), §0-§6.

/**
 * Who is paying, which decides which rules apply.
 *
 * Deliberately not defaulted. R0.1 makes identifying the funder a blocker in its own right, and
 * R0.2 says the two rulesets are not interchangeable -- they contradict each other on at least one
 * point (R-MPI.5 requires a credit card statement, R-DCS.9 says never to ask for one). Guessing
 * would therefore not be a small error; it would apply the wrong ruleset wholesale.
 */
export const adminBotReimbursementFunders = ["DCS", "MPI-IS"] as const;

export type AdminBotReimbursementFunder = (typeof adminBotReimbursementFunders)[number];

export const ADMINBOT_FUNDER_LABELS: Record<AdminBotReimbursementFunder, string> = {
  DCS: "University of Toronto — Department of Computer Science",
  "MPI-IS": "Max Planck Institute for Intelligent Systems, Tübingen",
};

/**
 * `blocker` returns or denies the claim; `warn` invites a follow-up question.
 *
 * The gate is on blockers alone. A warning that stopped submission would make the check worse than
 * useless -- people would route around it -- and the ruleset's own instruction is to flag warnings
 * and allow submission with a note.
 */
export type AdminBotReimbursementSeverity = "blocker" | "warn";

export type AdminBotReimbursementRule = {
  id: string;
  severity: AdminBotReimbursementSeverity;
  /** Which funders it applies to. Universal rules list both. */
  funders: readonly AdminBotReimbursementFunder[];
  /** One line an auditor would recognise. */
  title: string;
  /** When the rule is evaluated at all. Rules whose trigger is absent are not failures. */
  trigger: string;
  /** What the claimant has to supply when it fails. Shown verbatim to the user. */
  remedy: string;
  /**
   * Evidence that cannot be produced after the fact.
   *
   * §6.4 asks for these to be reported separately, because the decision they force is different:
   * not "go and fetch it" but "submit a weakened claim or drop the line".
   */
  unrecoverable?: true;
};

const BOTH = ["DCS", "MPI-IS"] as const;

/** §1 Universal rules. */
const UNIVERSAL: AdminBotReimbursementRule[] = [
  {
    id: "R1.1",
    severity: "blocker",
    funders: BOTH,
    title: "Expense form present and signed",
    trigger: "Always, including non-travel and hospitality-only claims.",
    remedy:
      "Complete the claimant section of the expense form and affix a signature. A claim that is only receipts fails.",
  },
  {
    id: "R1.2",
    severity: "blocker",
    funders: BOTH,
    title: "Proof of stay for every accommodation line",
    trigger: "Any accommodation is claimed.",
    remedy:
      "Attach the hotel's own detailed check-out folio showing check-in and check-out dates, itemized nightly rates, taxes and completed payment. A booking confirmation, reservation email, card charge or third-party receipt does not satisfy this. Peer-to-peer lodging needs the platform's original invoice.",
    unrecoverable: true,
  },
  {
    id: "R1.3",
    severity: "blocker",
    funders: BOTH,
    title: "Proof that travel occurred",
    trigger: "Any air or rail fare is claimed.",
    remedy:
      "DCS: attach at least one of a destination hotel bill, an airport or station taxi/transit receipt, a destination meal receipt, a certificate of attendance, or a boarding pass. MPI-IS: supply boarding passes as standard.",
  },
  {
    id: "R1.4",
    severity: "blocker",
    funders: BOTH,
    title: "Every amount traces to a document showing amount and date",
    trigger: "Always, per line item.",
    remedy:
      "For each claimed figure attach a receipt or statement extract showing the same amount and the transaction date. Recompute every foreign-currency line and confirm it reconciles. A filename asserting an amount is not a document.",
  },
  {
    id: "R1.5",
    severity: "blocker",
    funders: BOTH,
    title: "Business purpose stated for every expense",
    trigger: "Always, per line item.",
    remedy:
      'State, per receipt, what the activity was, who it involved and why it served the funder\'s business. A descriptive filename, a purpose given for a batch, or a generic label such as "lunch" or "team dinner" all fail.',
  },
  {
    id: "R1.6",
    severity: "blocker",
    funders: BOTH,
    title: "Attendees listed per receipt for meals and hospitality",
    trigger: "Any meal, lunch, dinner or hospitality expense.",
    remedy:
      "Give each individual receipt its own named attendee list. One list covering several receipts from the same trip fails.",
  },
  {
    id: "R1.7",
    severity: "blocker",
    funders: BOTH,
    title: "No per diem where the meal was covered elsewhere",
    trigger: "A meal per diem is claimed.",
    remedy:
      "Check the hotel rate description for breakfast included and the conference agenda for provided meals, and remove any per diem those cover.",
  },
  {
    id: "R1.8",
    severity: "blocker",
    funders: BOTH,
    title: "No formula residue in unclaimed sections",
    trigger: "The form has calculated fields.",
    remedy: "Clear every section you are not claiming to zero or blank.",
  },
  {
    id: "R1.9",
    severity: "blocker",
    funders: BOTH,
    title: "Expense personally incurred by the claimant",
    trigger: "Always.",
    remedy:
      "The payment instrument must belong to the claimant. An expense paid on somebody else's card has to be claimed by that person.",
  },
  {
    id: "R1.10",
    severity: "blocker",
    funders: BOTH,
    title: "Shared links resolve for an external viewer",
    trigger: "Any evidence is provided by link rather than attachment.",
    remedy:
      "Open every link in a logged-out or incognito window and confirm it reaches the intended file with view permission for the finance office.",
  },
  {
    id: "R1.11",
    severity: "warn",
    funders: BOTH,
    title: "Receipts ordered and numbered to match the form",
    trigger: "Always.",
    remedy:
      "Order the receipts as the items appear on the form; where numerous, number them and put the numbers on the form.",
  },
  {
    id: "R1.12",
    severity: "blocker",
    funders: BOTH,
    title: "Non-reimbursable items excluded",
    trigger: "Always.",
    remedy:
      "Remove any cellphone, passport or NEXUS fee, fine, personal travel insurance, personal entertainment, club membership, family travel, reward-point airfare, unapproved premium-fare difference, or non-business stopover.",
  },
];

/** §2 Extended or mixed personal/business travel. */
const MIXED_TRAVEL: AdminBotReimbursementRule[] = [
  {
    id: "R2.1",
    severity: "blocker",
    funders: BOTH,
    title: "Business-portion fare quote captured at booking time",
    trigger:
      "Personal travel is combined with business travel, or the split is not evident from the ticket.",
    remedy:
      "Attach a fare quote for the business portion only, captured at the same time as the actual booking, alongside the real invoice. A quote obtained afterwards is not comparable and does not satisfy this rule.",
    unrecoverable: true,
  },
  {
    id: "R2.2",
    severity: "blocker",
    funders: BOTH,
    title: "Quote and invoice comparable",
    trigger: "R2.1 applies.",
    remedy:
      "The quote and the booking invoice must carry the same date and the same booking conditions — same class, same carrier type, same refundability.",
  },
  {
    id: "R2.3",
    severity: "blocker",
    funders: BOTH,
    title: "Business purpose stated per leg",
    trigger: "Any leg does not originate at, or return to, the home address on the form.",
    remedy:
      "Explain the business purpose of each such leg individually on the trip summary. An unexplained leg reads as personal travel.",
  },
  {
    id: "R2.4",
    severity: "blocker",
    funders: BOTH,
    title: "No accommodation or per diem on personal days",
    trigger: "The trip extends beyond the event window.",
    remedy:
      "Limit accommodation and meal claims to the eligible window — generally the day before the event through the day after.",
  },
  {
    id: "R2.5",
    severity: "warn",
    funders: BOTH,
    title: "Approver notified before booking",
    trigger: "R2.1 applies.",
    remedy:
      "Attach written evidence that the approver knew about the combined trip before booking.",
  },
  {
    id: "R2.6",
    severity: "blocker",
    funders: BOTH,
    title: "Premium cabin pre-authorised",
    trigger: "Any fare above least-expensive economy is claimed.",
    remedy:
      "Attach written pre-authorisation from the chair, dean, director or equivalent, dated before the booking. A segment over 6 hours or medical reasons are accepted justifications; economy being unavailable because of late booking is not.",
  },
  {
    id: "R2.7",
    severity: "warn",
    funders: BOTH,
    title: "Booked at least 14 days before departure",
    trigger: "Any fare is claimed.",
    remedy: "Book at least 14 days ahead, or note why that was not possible.",
  },
];

/** §3 Who may incur the expense. */
const WHO_PAYS: AdminBotReimbursementRule[] = [
  {
    id: "R3.1",
    severity: "blocker",
    funders: BOTH,
    title: "A junior member may not pay for a senior member's accommodation",
    trigger: "Accommodation was booked for somebody other than the payer.",
    remedy:
      "The senior member must incur the expense personally and claim it themselves. Booking for a peer at the same level is fine.",
  },
  {
    id: "R3.3",
    severity: "blocker",
    funders: BOTH,
    title: "Shared accommodation on the most senior occupant's card",
    trigger: "Accommodation is shared.",
    remedy:
      "Book shared accommodation on the card of the most senior person staying in it. Where that person is not staying, a junior member may book for the group.",
  },
  {
    id: "R3.4",
    severity: "blocker",
    funders: BOTH,
    title: "Nobody may purchase airfare for another person",
    trigger: "Airfare is claimed.",
    remedy:
      "Each traveller buys their own ticket. Refunds credit back to the purchaser, which breaks the payment trail.",
  },
  {
    id: "R3.5",
    severity: "blocker",
    funders: BOTH,
    title: "Group meals paid by the most senior institutional employee present",
    trigger: "A group meal or hospitality expense is claimed.",
    remedy:
      "The most senior institutional employee present pays. A claim where a junior member paid for a group including senior employees fails.",
  },
];

/** §4 DCS-specific. */
const DCS_RULES: AdminBotReimbursementRule[] = [
  {
    id: "R-DCS.1",
    severity: "blocker",
    funders: ["DCS"],
    title: "Expense Form, Trip Summary Form and Compute Expense Form present",
    trigger: "Always; the compute form only where compute costs are claimed.",
    remedy: "Produce all the forms the claim requires, not just the expense form.",
  },
  {
    id: "R-DCS.2",
    severity: "blocker",
    funders: ["DCS"],
    title: "Submitted within 3 working weeks of the trip ending",
    trigger: "A trip end date is known.",
    remedy: "Submit within 3 working weeks of the trip ending.",
  },
  {
    id: "R-DCS.3",
    severity: "blocker",
    funders: ["DCS"],
    title: "Transaction dates under 2 years old",
    trigger: "Any transaction date is known.",
    remedy:
      "Expenses two years or older cannot be submitted and are not eligible. Remove them from the claim.",
  },
  {
    id: "R-DCS.4",
    severity: "warn",
    funders: ["DCS"],
    title: "Transactions 1–2 years old need written justification",
    trigger: "Any transaction is between 1 and 2 years old.",
    remedy: "Attach written justification and obtain one-up approval for these lines.",
  },
  {
    id: "R-DCS.5",
    severity: "blocker",
    funders: ["DCS"],
    title: "Form address is where payment should be delivered",
    trigger: "Always.",
    remedy:
      "Confirm the address on the form is where the claimant wants payment sent, especially for cheque and foreign-currency cheque payments.",
  },
  {
    id: "R-DCS.6",
    severity: "blocker",
    funders: ["DCS"],
    title: "Conference registration has confirmation and proof of payment",
    trigger: "Conference registration is claimed.",
    remedy: "Attach both the registration confirmation and proof that it was paid.",
  },
  {
    id: "R-DCS.7",
    severity: "warn",
    funders: ["DCS"],
    title: "Missing receipt form signed by the approver",
    trigger: "A Missing/Difficult to Receipt form is used.",
    remedy:
      "Get the approver's signature on it. Repeated use in place of collecting receipts may cause denial.",
  },
  {
    id: "R-DCS.8",
    severity: "blocker",
    funders: ["DCS"],
    title: "Split funding declared",
    trigger: "The claim is split with another funding source.",
    remedy:
      "Claim only this institution's share, attach copies of the receipts, and include a declaration that the amount has not been claimed elsewhere.",
  },
  {
    id: "R-DCS.10",
    severity: "blocker",
    funders: ["DCS"],
    title: "Institutional email used",
    trigger: "Always.",
    remedy: "Use the institutional email address on forms and correspondence, not a personal one.",
  },
  {
    id: "R-DCS.11",
    severity: "warn",
    funders: ["DCS"],
    title: "Finance contact not on leave",
    trigger: "Always.",
    remedy:
      "Check the finance contact is not out of office; submissions during leave sit unprocessed.",
  },
];

/** §5 MPI IS-specific. */
const MPI_RULES: AdminBotReimbursementRule[] = [
  {
    id: "R-MPI.1",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Private address matching the bank account",
    trigger: "Always.",
    remedy:
      "Put the claimant's private address on the form, matching the bank account. A university or business address fails.",
  },
  {
    id: "R-MPI.2",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Reason for refund in the institute's expected form",
    trigger: "Always.",
    remedy: "State the reason as: trip to [location] to present [what].",
  },
  {
    id: "R-MPI.3",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "All amounts converted to EUR",
    trigger: "Always.",
    remedy: "Convert every amount on the form to EUR.",
  },
  {
    id: "R-MPI.4",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Conversions via oanda.com, attached as PDFs",
    trigger: "Any amount was incurred in a currency other than EUR.",
    remedy:
      "Convert on oanda.com using the total and the date the expense was incurred, and attach each conversion output as a PDF.",
  },
  {
    id: "R-MPI.5",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Credit card statement attached",
    trigger: "Always.",
    remedy:
      "Attach the claimant's credit card statement as proof of payment. (DCS is the opposite — see R-DCS.9 — which is why the funder has to be chosen first.)",
  },
  {
    id: "R-MPI.6",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "All receipts attached as PDF or photo",
    trigger: "Always.",
    remedy:
      "Attach boarding passes, the flight booking confirmation, the registration confirmation and any train or bus receipts as PDFs or photos.",
  },
  {
    id: "R-MPI.7",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Only the totals adding up to the approved cap",
    trigger: "The director approved a maximum refund total.",
    remedy:
      "Submit only the main totals that add up to the cap. Do not submit every receipt beyond it.",
  },
  {
    id: "R-MPI.8",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Director's confirmation email forwarded",
    trigger: "Always.",
    remedy: "Forward the email in which the director confirmed the refund to the secretariat.",
  },
  {
    id: "R-MPI.9",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Supervisor's justification text attached",
    trigger: "Always.",
    remedy:
      "Attach a justification written from the director's perspective: why the claimant had to be sent, and the connection to the institute. Request this early — the claim cannot proceed without it.",
  },
  {
    id: "R-MPI.10",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Form dated and signed at the guest's signature field",
    trigger: "Always.",
    remedy: "Date and sign the form in the guest's signature box.",
  },
  {
    id: "R-MPI.11",
    severity: "blocker",
    funders: ["MPI-IS"],
    title: "Director approval obtained before the trip",
    trigger: "Always.",
    remedy:
      "The claim rests on approval given before the trip. Approval obtained afterwards does not satisfy this.",
    unrecoverable: true,
  },
];

/** §0 Funder determination, and the grant-window warning that rides with it. */
const FUNDER_RULES: AdminBotReimbursementRule[] = [
  {
    id: "R0.1",
    severity: "blocker",
    funders: BOTH,
    title: "Funder identified before anything else is evaluated",
    trigger: "Always.",
    remedy: "Choose the reimbursement institute — UofT DCS or MPI IS — before preparing anything.",
  },
  {
    id: "R0.3",
    severity: "warn",
    funders: BOTH,
    title: "Grant category still open",
    trigger: "The expense category is grant-restricted.",
    remedy:
      "Confirm the grant category is still open as of the submission date. Grant categories expire independently of the trip date.",
  },
];

export const adminBotReimbursementRules: readonly AdminBotReimbursementRule[] = [
  ...FUNDER_RULES,
  ...UNIVERSAL,
  ...MIXED_TRAVEL,
  ...WHO_PAYS,
  ...DCS_RULES,
  ...MPI_RULES,
];

export function rulesForFunder(funder: AdminBotReimbursementFunder): AdminBotReimbursementRule[] {
  return adminBotReimbursementRules.filter((rule) => rule.funders.includes(funder));
}

export function reimbursementRule(id: string): AdminBotReimbursementRule | undefined {
  return adminBotReimbursementRules.find((rule) => rule.id === id);
}

// --- the evidence the check reads --------------------------------------------------------

/**
 * One claimed amount and whether it reconciles against an attached document.
 *
 * `reconciled` is the model's answer to R1.4 after recomputing the line -- including the currency
 * conversion, which is where these usually break. `note` carries why it could not be reconciled,
 * so the amounts-checked section can list it rather than silently dropping it.
 */
export type AdminBotReimbursementAmount = {
  label: string;
  /** ISO date of the transaction, for the two DCS age windows. */
  date?: string;
  reconciled: boolean;
  note?: string;
};

/**
 * What the conversation established about the package, as flags the checker can evaluate.
 *
 * Every boolean is "this has been positively established", never "this is fine". Absent means
 * unsatisfied and the rule fails -- see the fail-closed note at the top of check.ts. That is why
 * they are all optional: a stored draft written before a flag existed must not read as a pass.
 */
export type AdminBotReimbursementEvidence = {
  funder?: AdminBotReimbursementFunder;
  amounts: AdminBotReimbursementAmount[];

  // §0
  grant_restricted?: boolean;
  grant_category_open?: boolean;

  // §1 universal
  form_signed?: boolean;
  claims_accommodation?: boolean;
  accommodation_folio_attached?: boolean;
  claims_air_or_rail?: boolean;
  travel_occurred_evidence?: boolean;
  business_purpose_per_item?: boolean;
  claims_meals_or_hospitality?: boolean;
  attendees_per_receipt?: boolean;
  claims_per_diem?: boolean;
  per_diem_not_covered_elsewhere?: boolean;
  unclaimed_sections_cleared?: boolean;
  personally_incurred?: boolean;
  evidence_by_link?: boolean;
  links_verified_logged_out?: boolean;
  receipts_ordered?: boolean;
  /** Named non-reimbursable items found in the claim. Empty is the passing state. */
  non_reimbursable_items: string[];

  // §2 mixed travel
  mixed_personal_business?: boolean;
  business_portion_quote_at_booking?: boolean;
  quote_and_invoice_comparable?: boolean;
  has_legs_away_from_home?: boolean;
  purpose_per_leg?: boolean;
  trip_extends_beyond_event?: boolean;
  no_personal_day_claims?: boolean;
  approver_notified_before_booking?: boolean;
  premium_cabin?: boolean;
  premium_pre_authorised?: boolean;
  booked_14_days_ahead?: boolean;

  // §3 who paid
  accommodation_booked_for_others?: boolean;
  accommodation_shared?: boolean;
  accommodation_payer_seniority_ok?: boolean;
  airfare_self_purchased?: boolean;
  claims_group_meal?: boolean;
  group_meal_paid_by_senior?: boolean;

  // §4 DCS
  dcs_forms_complete?: boolean;
  /** ISO date the trip ended, for the 3-working-week deadline. */
  trip_end_date?: string;
  old_transaction_justification?: boolean;
  payment_address_confirmed?: boolean;
  claims_registration?: boolean;
  registration_confirmation_and_payment?: boolean;
  uses_missing_receipt_form?: boolean;
  missing_receipt_form_signed?: boolean;
  split_funding?: boolean;
  split_funding_declared?: boolean;
  institutional_email?: boolean;
  finance_contact_available?: boolean;

  // §5 MPI IS
  private_address_matches_bank?: boolean;
  reason_for_refund_stated?: boolean;
  all_amounts_in_eur?: boolean;
  has_non_eur_amounts?: boolean;
  oanda_conversions_attached?: boolean;
  card_statement_attached?: boolean;
  receipts_attached_as_files?: boolean;
  /** The cap the director approved, when there is one. Absent means no cap was set. */
  director_cap_amount?: number;
  totals_within_cap?: boolean;
  director_email_forwarded?: boolean;
  supervisor_justification_attached?: boolean;
  guest_signature_and_date?: boolean;
  director_approved_before_trip?: boolean;
};

/** An evidence set with nothing established. The starting point, and a failing one by design. */
export function emptyReimbursementEvidence(): AdminBotReimbursementEvidence {
  return { amounts: [], non_reimbursable_items: [] };
}

// --- the check result --------------------------------------------------------------------

export type AdminBotReimbursementFinding = {
  rule_id: string;
  severity: AdminBotReimbursementSeverity;
  title: string;
  /** What is actually missing on this package, in the checker's words. */
  detail: string;
  remedy: string;
  /** §6.4: cannot be fixed after the fact, so it forces a decision rather than an errand. */
  unrecoverable?: boolean;
};

/**
 * The §6 output, and the thing the generate path gates on.
 *
 * `verdict` is derived from the blockers, never set independently -- a verdict that could disagree
 * with its own findings is how a package gets waved through with a blocker still on it.
 */
export type AdminBotReimbursementCheck = {
  funder?: AdminBotReimbursementFunder;
  verdict: "ready_to_submit" | "do_not_submit";
  blockers: AdminBotReimbursementFinding[];
  warnings: AdminBotReimbursementFinding[];
  /** Blockers that cannot be remedied, surfaced separately per §6.4. */
  unrecoverable: AdminBotReimbursementFinding[];
  /** §6.5: per-line confirmation that each amount was recomputed, or why it could not be. */
  amounts_checked: Array<{ label: string; reconciled: boolean; note?: string }>;
};
