/* @vitest-environment jsdom */
// The reimbursement tab's two new halves: choosing the institute, and the pre-submission report.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AdminBotReimbursementCheck } from "../../../../../extensions/adminbot/src/contracts/reimbursement-rules.js";
import type { AdminBotReimbursementState } from "../controllers/admin.ts";
import { renderAdminBotReimbursements, type AdminBotReimbursementProps } from "./reimbursements.ts";

function state(overrides: Partial<AdminBotReimbursementState> = {}): AdminBotReimbursementState {
  return {
    messages: [],
    draft: {},
    missingFields: [],
    receiptNames: [],
    ready: false,
    busy: false,
    error: null,
    artifacts: [],
    ...overrides,
  };
}

function draw(overrides: Partial<AdminBotReimbursementProps> = {}) {
  document.body.replaceChildren();
  const funders: string[] = [];
  const submits: number[] = [];
  const props: AdminBotReimbursementProps = {
    canSubmit: true,
    state: state(),
    onMessage: () => undefined,
    onGenerate: () => undefined,
    onReset: () => undefined,
    onFunderChange: (funder) => funders.push(funder),
    onSubmit: () => submits.push(1),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderAdminBotReimbursements(props), container);
  return { container, funders, submits };
}

describe("choosing the institute", () => {
  it("offers both and preselects neither", () => {
    const { container } = draw();
    const uoft = container.querySelector<HTMLInputElement>(
      '[data-testid="reimbursement-funder-DCS"]',
    );
    const mpi = container.querySelector<HTMLInputElement>(
      '[data-testid="reimbursement-funder-MPI-IS"]',
    );
    expect(uoft).not.toBeNull();
    expect(mpi).not.toBeNull();
    // Never defaulted: the two rulesets contradict each other, so a guess applies the wrong one
    // wholesale rather than being a near miss.
    expect(uoft?.checked).toBe(false);
    expect(mpi?.checked).toBe(false);
  });

  it("reports the choice", () => {
    const { container, funders } = draw();
    container
      .querySelector<HTMLInputElement>('[data-testid="reimbursement-funder-MPI-IS"]')
      ?.click();
    expect(funders).toEqual(["MPI-IS"]);
  });

  it("locks once a conversation exists, because the rulesets ask different questions", () => {
    const { container } = draw({
      state: state({
        funder: "DCS",
        messages: [{ role: "user", content: "Here are my receipts" }],
      }),
    });
    const uoft = container.querySelector<HTMLInputElement>(
      '[data-testid="reimbursement-funder-DCS"]',
    );
    expect(uoft?.disabled).toBe(true);
    expect(container.textContent).toContain("Start over to change institute");
  });
});

describe("the pre-submission report", () => {
  const blocked: AdminBotReimbursementCheck = {
    funder: "MPI-IS",
    verdict: "do_not_submit",
    blockers: [
      {
        rule_id: "R-MPI.5",
        severity: "blocker",
        title: "Credit card statement attached",
        detail: "The credit card statement is not attached.",
        remedy: "Attach the claimant's credit card statement as proof of payment.",
      },
      {
        rule_id: "R2.1",
        severity: "blocker",
        title: "Business-portion fare quote captured at booking time",
        detail: "Personal and business travel are combined with no business-only quote.",
        remedy: "Attach a fare quote for the business portion only.",
        unrecoverable: true,
      },
    ],
    warnings: [
      {
        rule_id: "R1.11",
        severity: "warn",
        title: "Receipts ordered and numbered",
        detail: "Receipts are not ordered to match the form.",
        remedy: "Order the receipts as the items appear on the form.",
      },
    ],
    unrecoverable: [],
    amounts_checked: [
      { label: "Flight CHF 1174.80", reconciled: true },
      { label: "Hotel EUR 612", reconciled: false, note: "no folio attached" },
    ],
  };

  it("says nothing until an institute is chosen", () => {
    const { container } = draw();
    expect(container.querySelector('[data-testid="reimbursement-check"]')).toBeNull();
  });

  it("names every blocker with its rule id and what to supply", () => {
    const { container } = draw({ state: state({ funder: "MPI-IS", check: blocked }) });
    const panel = container.querySelector('[data-testid="reimbursement-check"]');
    expect(panel?.textContent).toContain("Do not submit");
    // The rule id matters: the finance office quotes them back.
    expect(panel?.textContent).toContain("R-MPI.5");
    expect(panel?.textContent).toContain("credit card statement");
    expect(panel?.textContent).toContain("No forms were generated");
  });

  it("flags what cannot be produced after the fact", () => {
    const { container } = draw({ state: state({ funder: "MPI-IS", check: blocked }) });
    expect(container.textContent).toContain("Cannot be produced after the fact");
  });

  it("separates warnings from blockers", () => {
    const { container } = draw({ state: state({ funder: "MPI-IS", check: blocked }) });
    const warnings = container.querySelector('[data-testid="reimbursement-warnings"]');
    expect(warnings?.textContent).toContain("R1.11");
    expect(warnings?.textContent).not.toContain("R-MPI.5");
  });

  it("lists which amounts reconciled and which did not", () => {
    const { container } = draw({ state: state({ funder: "MPI-IS", check: blocked }) });
    const text = container.textContent ?? "";
    expect(text).toContain("Flight CHF 1174.80 — reconciled");
    expect(text).toContain("no folio attached");
  });

  it("still shows when the package cleared, so 'passed' is distinguishable from 'never ran'", () => {
    const { container } = draw({
      state: state({
        funder: "DCS",
        check: {
          funder: "DCS",
          verdict: "ready_to_submit",
          blockers: [],
          warnings: [],
          unrecoverable: [],
          amounts_checked: [],
        },
      }),
    });
    const panel = container.querySelector('[data-testid="reimbursement-check"]');
    expect(panel?.textContent).toContain("Ready to submit");
    expect(panel?.textContent).toContain("UofT DCS");
  });
});

describe("sending the package", () => {
  const artifacts = [
    { filename: "MPI_IS_Reimbursement_Ada.pdf", media_type: "application/pdf", data_base64: "x" },
  ];

  it("offers nothing until forms exist", () => {
    const { container } = draw({ state: state({ funder: "MPI-IS" }) });
    expect(container.querySelector('[data-testid="reimbursement-submit"]')).toBeNull();
  });

  it("names the office before it is pressed", () => {
    const { container } = draw({ state: state({ funder: "MPI-IS", artifacts }) });
    const button = container.querySelector('[data-testid="reimbursement-submit"]');
    // A send button that does not say where it goes is one people press without knowing.
    expect(button?.textContent).toContain("MPI IS secretariat");
    // Whitespace-normalised: the copy wraps across lines in the template.
    const text = (container.textContent ?? "").replace(/\s+/gu, " ");
    expect(text).toContain("reply-to to your correspondence address");
  });

  it("names the other office for the other funder", () => {
    const { container } = draw({ state: state({ funder: "DCS", artifacts }) });
    expect(container.querySelector('[data-testid="reimbursement-submit"]')?.textContent).toContain(
      "DCS finance office",
    );
  });

  it("reports the press", () => {
    const { container, submits } = draw({ state: state({ funder: "DCS", artifacts }) });
    container.querySelector<HTMLButtonElement>('[data-testid="reimbursement-submit"]')?.click();
    expect(submits).toEqual([1]);
  });

  it("says where it went and who replies once sent", () => {
    const { container } = draw({
      state: state({
        funder: "MPI-IS",
        artifacts,
        submission: { to: "secretariat@tue.mpg.de", reply_to: "ada@example.org" },
      }),
    });
    const sent = container.querySelector('[data-testid="reimbursement-sent"]');
    expect(sent?.textContent).toContain("secretariat@tue.mpg.de");
    expect(sent?.textContent).toContain("ada@example.org");
    // And offers no second send.
    expect(container.querySelector('[data-testid="reimbursement-submit"]')).toBeNull();
  });
});
