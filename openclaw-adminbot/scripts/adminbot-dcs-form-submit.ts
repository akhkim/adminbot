#!/usr/bin/env -S node --import tsx
// Submits the DCS Slack-access request form (https://forms.office.com/r/TgGWBGWLZa) on behalf of
// a newly approved lab member.
//
// Runs as its own process (spawned by extensions/adminbot/src/connectors/dcs-form.ts) rather than
// importing Playwright into the AdminBot server itself, so a browser crash/hang can never take the
// API down with it -- the same reason the OpenReview and reimbursement connectors shell out to
// their own scripts instead of linking a heavy runtime in-process.
//
// Reads one JSON object from stdin: { firstName, lastName, email, formUrl? }. Writes exactly one
// JSON line to stdout -- { ok: true } or { ok: false, error } -- and exits 0/1 to match.
//
// The form has no public submission API: this drives a real (headless) browser through it the way
// a person would, using Microsoft Forms' own `data-automation-id` hooks rather than guessed CSS
// classes or translated label text, since those are the most stable selectors the form exposes.
// Field layout confirmed by hand against the live form on 2026-08-09 (see the question list
// below); Microsoft can change it at any time without notice, and the selectors here need to be
// re-checked against the real form if this starts failing.
//
// Verified interactively up through selecting Sponsor and Group; the actual Submit click and its
// success confirmation were deliberately never exercised against the real form during development
// (that would have filed a real, fake request under a real sponsor's name). Treat the first few
// real runs as needing a human to confirm the request actually landed.

import { chromium, type Locator, type Page } from "playwright";

const DEFAULT_FORM_URL = "https://forms.office.com/r/TgGWBGWLZa";

// Fixed per the feature request: every new member is submitted with the same sponsor and group,
// regardless of who they are. There is no per-member sponsor/group concept anywhere else in
// AdminBot to derive these from (see extensions/adminbot/src/contracts/actions.ts) -- this is a
// DCS-form-specific constant, not roster data.
const SPONSOR = "Jin, Zhijing";
const GROUP = "External Visitor";

const NAV_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 15_000;

export type DcsFormSubmitParams = {
  firstName: string;
  lastName: string;
  email: string;
  formUrl?: string;
};

// Question containers share one shape (`data-automation-id="questionItem"`), each carrying its
// ordinal-prefixed title in its own text ("1.First NameSingle line text."). Anchoring the match at
// the start of that text (^\d+\.) is what keeps "Email" (question 3) from also matching "Please
// re-enter your email address..." (question 4) -- a plain substring match would not.
function questionItem(page: Page, labelPattern: RegExp): Locator {
  return page.locator('[data-automation-id="questionItem"]').filter({ hasText: labelPattern });
}

async function fillTextQuestion(page: Page, labelPattern: RegExp, value: string): Promise<void> {
  await questionItem(page, labelPattern)
    .locator('[data-automation-id="textInput"]')
    .fill(value, { timeout: ACTION_TIMEOUT_MS });
}

// The Group question: a plain set of radio choices, one `data-automation-id="choiceItem"]` per
// option.
async function selectChoiceQuestion(
  page: Page,
  labelPattern: RegExp,
  optionText: string,
): Promise<void> {
  await questionItem(page, labelPattern)
    .locator('[data-automation-id="choiceItem"]')
    .filter({ hasText: optionText })
    .click({ timeout: ACTION_TIMEOUT_MS });
}

// The Sponsor question: a combobox button that opens a listbox of ~100 names, rendered outside
// the question's own DOM subtree once open, so the option is looked up on the page rather than
// scoped to the question container.
async function selectDropdownQuestion(
  page: Page,
  labelPattern: RegExp,
  optionText: string,
): Promise<void> {
  await questionItem(page, labelPattern)
    .getByRole("button", { name: /select your answer/i })
    .click({ timeout: ACTION_TIMEOUT_MS });
  await page.getByRole("option", { name: optionText, exact: true }).click({
    timeout: ACTION_TIMEOUT_MS,
  });
}

export async function submitDcsForm(params: DcsFormSubmitParams): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(params.formUrl ?? DEFAULT_FORM_URL, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT_MS,
    });

    await fillTextQuestion(page, /^\d+\.First Name/u, params.firstName);
    await fillTextQuestion(page, /^\d+\.Last Name/u, params.lastName);
    await fillTextQuestion(page, /^\d+\.Email/u, params.email);
    await fillTextQuestion(page, /^\d+\.Please re-enter your email/u, params.email);
    await selectDropdownQuestion(page, /^\d+\.Sponsor/u, SPONSOR);
    await selectChoiceQuestion(page, /^\d+\.Which group do you primarily belong to\?/u, GROUP);
    // Questions 7-8 (existing CSLab account name, UTORid) are optional and left blank: a
    // brand-new external visitor has neither yet.

    await page.getByRole("button", { name: "Submit" }).click({ timeout: ACTION_TIMEOUT_MS });
    // Best-effort confirmation only: the exact post-submit markup was never observed against a
    // real submission (see file header), so a missing match here is not treated as failure --
    // the click itself throwing is the actual failure signal (MS Forms blocks/​flags the submit
    // button rather than silently no-op'ing when a required question is left unanswered).
    await page
      .getByText(/response.*(recorded|submitted)|thank you/iu)
      .first()
      .waitFor({ timeout: ACTION_TIMEOUT_MS })
      .catch(() => {});
  } finally {
    await browser.close();
  }
}

function writeResult(result: { ok: true } | { ok: false; error: string }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

// The params travel as a single JSON CLI argument rather than stdin -- execFile passes argv
// directly to the child process with no shell involved, so there is no injection risk even with
// unusual characters in a name, and it avoids needing a separate stdin-piping code path in the
// connector that spawns this script.
async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) {
    writeResult({ ok: false, error: "expected one JSON argument with firstName/lastName/email" });
    return;
  }
  let params: DcsFormSubmitParams;
  try {
    params = JSON.parse(raw) as DcsFormSubmitParams;
  } catch {
    writeResult({ ok: false, error: "invalid JSON argument" });
    return;
  }
  if (!params.firstName?.trim() || !params.lastName?.trim() || !params.email?.trim()) {
    writeResult({ ok: false, error: "firstName, lastName, and email are required" });
    return;
  }
  try {
    await submitDcsForm(params);
    writeResult({ ok: true });
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// Only runs the CLI path when executed directly; importers (tests, the connector's in-process
// fallback) get submitDcsForm without triggering it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
