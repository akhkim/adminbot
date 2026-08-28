#!/usr/bin/env tsx
// Fetches each applicant's own filled-in application-form response and writes the
// address -> link map that `adminbot-onboarding-batch-plan.ts --form-links` consumes.
//
//   node --import tsx scripts/adminbot-form-response-links.ts <formId> [--out links.json]
//
// Needs GOG_KEYRING_PASSWORD in the environment: gog's token sits in a file keyring, so a
// non-interactive shell cannot read it otherwise.
//
// ## What Google can and cannot give us
//
// There is no API that returns a responder's *edit* URL. The Forms API's `responses.list` returns
// `responseId`, `respondentEmail` and the answers; `getEditResponseUrl()` exists only in Apps
// Script, bound to the form. So this builds the link the API does support:
//
//   https://docs.google.com/forms/d/<formId>/edit#response=<responseId>
//
// which opens that one submission in the form's own responses view. That is the link the mail
// actually needs: the copy says the response has been forwarded "to our Jinesis project lead
// cc'ed", and it is the lead -- who has access to the form -- who has to read the answers.
//
// The applicant themself cannot open it. That is a real limitation and the reason this prints a
// warning rather than pretending otherwise: if the lab wants a link the *applicant* can edit, it
// has to come from an Apps Script pass over the form, and `--links` accepts that file instead.
//
// `respondentEmail` is only populated when the form collects email addresses. When it is absent
// this falls back to any answer that looks like an address, and reports every response it could
// not attribute rather than dropping it.
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { resolveGogExecutable } from "../extensions/adminbot/src/connectors/gog.ts";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 60_000;
const GOG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 100;

export type FormResponse = {
  responseId?: string;
  respondentEmail?: string;
  answers?: Record<string, { textAnswers?: { answers?: { value?: string }[] } }>;
};

const EMAIL_PATTERN = /[^\s<>@,;]+@[^\s<>@,;]+\.[a-z]{2,}/iu;

/**
 * The address a response belongs to.
 *
 * `respondentEmail` when the form collected it; otherwise the first answer that looks like an
 * address, since these forms ask for one in a free-text question. Returns undefined rather than a
 * guess -- an unattributed response must be reported, not mailed to the wrong person.
 */
export function addressOfResponse(response: FormResponse): string | undefined {
  const collected = response.respondentEmail?.trim();
  if (collected?.includes("@")) {
    return collected.toLowerCase();
  }
  for (const answer of Object.values(response.answers ?? {})) {
    for (const entry of answer.textAnswers?.answers ?? []) {
      const found = entry.value?.match(EMAIL_PATTERN)?.[0];
      if (found) {
        return found.toLowerCase();
      }
    }
  }
  return undefined;
}

/** The responses view for one submission. See the header for why this shape and not an edit URL. */
export function responseLink(formId: string, responseId: string): string {
  return `https://docs.google.com/forms/d/${formId}/edit#response=${responseId}`;
}

/**
 * gog wraps results in an envelope whose shape varies per command, so find the responses array
 * rather than assuming a top-level key -- the same tolerance `parseGogSheetRows` applies to sheets.
 */
export function parseFormResponses(output: string): FormResponse[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("gog forms responses list did not return JSON output");
  }
  const found = findResponses(parsed);
  return found ?? [];
}

function looksLikeResponses(value: unknown[]): boolean {
  return value.every(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      ("responseId" in entry || "respondentEmail" in entry || "answers" in entry),
  );
}

function findResponses(value: unknown): FormResponse[] | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 && looksLikeResponses(value) ? (value as FormResponse[]) : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const responses = record.responses;
  if (Array.isArray(responses) && (responses.length === 0 || looksLikeResponses(responses))) {
    return responses as FormResponse[];
  }
  for (const entry of Object.values(record)) {
    const found = findResponses(entry);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function nextPageToken(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const token = parsed.nextPageToken;
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}

export type LinkMap = Record<string, string>;

export function buildLinkMap(
  formId: string,
  responses: readonly FormResponse[],
): { links: LinkMap; unattributed: string[] } {
  const links: LinkMap = {};
  const unattributed: string[] = [];
  for (const response of responses) {
    const responseId = response.responseId?.trim();
    if (!responseId) {
      continue;
    }
    const address = addressOfResponse(response);
    if (!address) {
      unattributed.push(responseId);
      continue;
    }
    // Later submissions win: someone who applied twice should be read at their newest answers, and
    // the API returns responses oldest-first.
    links[address] = responseLink(formId, responseId);
  }
  return { links, unattributed };
}

async function fetchResponses(formId: string, env: NodeJS.ProcessEnv): Promise<FormResponse[]> {
  const gog = resolveGogExecutable(env);
  const collected: FormResponse[] = [];
  let page: string | undefined;
  do {
    const { stdout } = await execFile(
      gog,
      [
        "--json",
        "--no-input",
        "--readonly",
        "--enable-commands-exact",
        "forms.responses.list",
        ...(env.GOG_ACCOUNT?.trim() ? ["--account", env.GOG_ACCOUNT.trim()] : []),
        "forms",
        "responses",
        "list",
        formId,
        "--max",
        String(PAGE_SIZE),
        ...(page ? ["--page", page] : []),
      ],
      { env, maxBuffer: GOG_MAX_OUTPUT_BYTES, timeout: GOG_TIMEOUT_MS, windowsHide: true },
    );
    collected.push(...parseFormResponses(stdout));
    page = nextPageToken(stdout);
  } while (page);
  return collected;
}

async function main(argv: readonly string[]): Promise<void> {
  const formId = argv.find((arg) => !arg.startsWith("--"));
  if (!formId) {
    console.error("usage: <formId> [--out links.json]");
    process.exit(1);
  }
  if (!process.env.GOG_KEYRING_PASSWORD) {
    console.error(
      "GOG_KEYRING_PASSWORD is not set: gog's token is in a file keyring and cannot be read non-interactively.",
    );
    process.exit(1);
  }
  const responses = await fetchResponses(formId, process.env);
  const { links, unattributed } = buildLinkMap(formId, responses);
  const output = `${JSON.stringify(links, undefined, 2)}\n`;
  const outIndex = argv.indexOf("--out");
  if (outIndex !== -1 && argv[outIndex + 1]) {
    fs.writeFileSync(argv[outIndex + 1] as string, output);
  } else {
    console.log(output);
  }
  console.error(`${responses.length} responses, ${Object.keys(links).length} addressed`);
  for (const responseId of unattributed) {
    console.error(`  no address found on response ${responseId}`);
  }
  console.error(
    "note: these open the form's own responses view, which only people with form access can read.",
  );
}

if (process.argv[1]?.endsWith("adminbot-form-response-links.ts")) {
  await main(process.argv.slice(2));
}
