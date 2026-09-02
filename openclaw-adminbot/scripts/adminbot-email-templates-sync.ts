#!/usr/bin/env -S node --experimental-strip-types
/**
 * Reports where the email-template Google Doc and the shipped copy have drifted apart.
 *
 * The doc is where the templates are written and reviewed; `emails.ts` is what actually gets sent.
 * Keeping them in step was a manual transcription every time somebody edited a paragraph, which is
 * the kind of job that is done carefully twice and then not at all.
 *
 * Check-only by design. It would be a short step from here to rewriting `emails.ts` from the doc,
 * and that step is deliberately not taken: the doc is a working document. At the time this was
 * written it contained an approved template reading "your application to usGoogle Form response"
 * -- a botched edit -- and wrote `([LINK])` where the code carries `{application_form_link}`. An
 * unattended writer would have shipped both to applicants, and a literal placeholder reaching a
 * recipient is the one failure `emails.ts` opens by warning about. So this prints a diff and exits
 * non-zero; a human reads it and makes the edit.
 *
 * Usage:
 *   scripts/adminbot-email-templates-sync.ts                 # fetch the doc, diff, exit 1 on drift
 *   scripts/adminbot-email-templates-sync.ts --json          # same, machine-readable
 *   scripts/adminbot-email-templates-sync.ts --from <file>   # diff a saved documents.get payload
 *
 * The fetch is `gog docs cat --raw`, the same call and the same account the guidebook sync uses
 * (extensions/adminbot/src/guidebook/sync.ts), so it needs no credential of its own.
 */
import { execFile } from "node:child_process";
import { isMainModule } from "./lib/is-main-module.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseDocsJson,
  renderDocsDocumentAsMarkdown,
} from "../extensions/adminbot/src/guidebook/docs-json.js";
import { ADMINBOT_ONBOARDING_TEMPLATES } from "../extensions/adminbot/src/workflows/onboarding/emails.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAP_PATH = path.join(REPO_ROOT, "config/email-template-map.json");

export type TemplateMap = {
  documentId: string;
  /** Doc identifier -> template id in emails.ts. */
  templates: Record<string, string>;
  /** Literal doc text -> the placeholder the code carries. Applied longest-first. */
  tokens: Record<string, string>;
  /** Doc sections with no counterpart, and why. Anything else unmapped is reported as drift. */
  docOnly: Record<string, string>;
  /** Templates with no doc section, and why. */
  codeOnly: Record<string, string>;
};

/** One template as the doc states it. */
export type DocTemplate = {
  /** The slug line when the section has one, else the nearest heading. Keys the map. */
  id: string;
  heading: string;
  subject: string;
  body: string;
};

/**
 * Lines that describe a template rather than being part of one.
 *
 * The doc annotates each section with who sends it and what triggers it. In the Docs API these are
 * italic runs, and italics are a style rather than text, so they arrive as ordinary paragraphs and
 * have to be recognised by what they say.
 */
const METADATA_PREFIXES = [
  "status:",
  "sender:",
  "trigger:",
  "reply-to:",
  "note:",
];

/** The last line of every template. Copy after it is commentary, not part of the mail. */
const SIGNATURE_TAIL = "Jinesis Lab by Prof. Zhijing Jin";

function isHeading(block: string): boolean {
  return /^#{1,6} /u.test(block);
}

function headingText(block: string): string {
  return block.replace(/^#{1,6} /u, "").trim();
}

function isMetadata(block: string): boolean {
  const lowered = block.trim().toLowerCase();
  return METADATA_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function subjectOf(block: string): string | undefined {
  const match = /^\s*Subject:\s*(.+)$/isu.exec(block);
  return match?.[1]?.trim();
}

/**
 * Normalises one block of doc prose into the shape `emails.ts` stores.
 *
 * Curly quotes and dashes are what a word processor produces and what nobody types into a source
 * file, so they are folded rather than reported as drift every single run -- a checker that cries
 * about an apostrophe is a checker people stop reading.
 */
export function normalizeDocText(text: string): string {
  return text
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/—/gu, "--")
    .replace(/ /gu, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();
}

/** Replaces the literals the doc spells out with the placeholders the code fills in. */
export function applyTokens(
  text: string,
  tokens: Record<string, string>,
): string {
  // Longest first: a short literal that is a prefix of a longer one would otherwise consume it.
  const ordered = Object.keys(tokens).toSorted(
    (left, right) => right.length - left.length,
  );
  let out = text;
  for (const literal of ordered) {
    out = out.split(literal).join(tokens[literal] as string);
  }
  return out;
}

/**
 * Pulls every template out of the doc's markdown.
 *
 * A template is a `Subject:` block plus the prose under it. Its identity is the slug line the
 * section carries when it has one -- three of them do, and the convention is worth spreading --
 * and otherwise the nearest heading, which is why renaming a heading shows up here as an unmapped
 * section rather than as silence.
 */
export function parseTemplateDoc(markdown: string): DocTemplate[] {
  const blocks = markdown.split("\n\n").filter((block) => block.trim());
  const templates: DocTemplate[] = [];
  let heading = "";
  let slug: string | undefined;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as string;
    if (isHeading(block)) {
      heading = headingText(block);
      slug = undefined;
      continue;
    }
    const subject = subjectOf(block);
    if (!subject) {
      // A short, unpunctuated line right before a Subject is the section's slug. Anything longer is
      // prose, and anything that reads as metadata is an annotation.
      if (
        !isMetadata(block) &&
        !block.includes("\n") &&
        block.trim().length <= 60
      ) {
        slug = block.trim();
      }
      continue;
    }
    const body: string[] = [];
    for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
      const next = blocks[cursor] as string;
      if (isHeading(next) || subjectOf(next)) {
        break;
      }
      if (isMetadata(next)) {
        continue;
      }
      body.push(next);
      if (next.trimEnd().endsWith(SIGNATURE_TAIL)) {
        break;
      }
    }
    templates.push({
      id: slug ?? heading,
      heading,
      subject: normalizeDocText(subject),
      body: normalizeDocText(body.join("\n\n")),
    });
    slug = undefined;
  }
  return templates;
}

export type Drift =
  | {
      kind: "subject";
      id: string;
      templateId: string;
      doc: string;
      code: string;
    }
  | { kind: "body"; id: string; templateId: string; doc: string; code: string }
  | { kind: "unmapped-doc"; id: string; heading: string }
  | { kind: "missing-doc"; templateId: string }
  | { kind: "unfilled-token"; id: string; templateId: string; found: string[] };

/**
 * Everything the doc and the code disagree about.
 *
 * Unmapped sections are drift too, not a silent skip. A heading rename would otherwise turn a
 * template into one the checker no longer watches, which is the failure this whole script exists
 * to stop -- the copy going stale without anybody being told.
 */
export function compareTemplates(params: {
  docTemplates: DocTemplate[];
  codeTemplates: readonly { id: string; subject?: string; body: string }[];
  map: TemplateMap;
}): Drift[] {
  const { docTemplates, codeTemplates, map } = params;
  const byId = new Map(
    codeTemplates.map((template) => [template.id, template]),
  );
  const drift: Drift[] = [];
  const seen = new Set<string>();

  for (const docTemplate of docTemplates) {
    const templateId = map.templates[docTemplate.id];
    if (!templateId) {
      if (!(docTemplate.id in map.docOnly)) {
        drift.push({
          kind: "unmapped-doc",
          id: docTemplate.id,
          heading: docTemplate.heading,
        });
      }
      continue;
    }
    const code = byId.get(templateId);
    if (!code) {
      drift.push({ kind: "missing-doc", templateId });
      continue;
    }
    seen.add(templateId);
    const docSubject = applyTokens(docTemplate.subject, map.tokens);
    const docBody = applyTokens(docTemplate.body, map.tokens);
    // A bracket that survived the token map is a placeholder nobody taught the code about. Worth
    // its own finding: it is the shape of the failure emails.ts opens by warning about.
    const leftover = [...docBody.matchAll(/\[[A-Za-z_][^\]]{0,60}\]/gu)].map(
      (match) => match[0],
    );
    if (leftover.length > 0) {
      drift.push({
        kind: "unfilled-token",
        id: docTemplate.id,
        templateId,
        found: [...new Set(leftover)],
      });
    }
    if (code.subject !== undefined && docSubject !== code.subject.trim()) {
      drift.push({
        kind: "subject",
        id: docTemplate.id,
        templateId,
        doc: docSubject,
        code: code.subject.trim(),
      });
    }
    if (docBody !== code.body.trim()) {
      drift.push({
        kind: "body",
        id: docTemplate.id,
        templateId,
        doc: docBody,
        code: code.body.trim(),
      });
    }
  }

  for (const template of codeTemplates) {
    if (seen.has(template.id) || template.id in map.codeOnly) {
      continue;
    }
    if (Object.values(map.templates).includes(template.id)) {
      // Mapped, but the doc section it names never turned up.
      drift.push({ kind: "missing-doc", templateId: template.id });
    }
  }
  return drift;
}

/** A body diff, as the lines that differ rather than two walls of prose. */
function renderBodyDiff(doc: string, code: string): string[] {
  const docLines = doc.split("\n");
  const codeLines = code.split("\n");
  const out: string[] = [];
  for (
    let index = 0;
    index < Math.max(docLines.length, codeLines.length);
    index += 1
  ) {
    const left = codeLines[index];
    const right = docLines[index];
    if (left === right) {
      continue;
    }
    if (left !== undefined) out.push(`      - code: ${left.slice(0, 160)}`);
    if (right !== undefined) out.push(`      + doc:  ${right.slice(0, 160)}`);
  }
  return out;
}

export function renderReport(drift: Drift[]): string {
  if (drift.length === 0) {
    return "email templates: the doc and emails.ts agree";
  }
  const lines = [
    `email templates: ${drift.length} difference(s) between the doc and emails.ts`,
    "",
  ];
  for (const item of drift) {
    if (item.kind === "unmapped-doc") {
      lines.push(
        `  [unmapped]  "${item.id}" (under "${item.heading}") has no entry in config/email-template-map.json`,
      );
      continue;
    }
    if (item.kind === "missing-doc") {
      lines.push(
        `  [missing]   ${item.templateId} is mapped but no matching section is in the doc`,
      );
      continue;
    }
    if (item.kind === "unfilled-token") {
      lines.push(
        `  [token]     ${item.templateId}: the doc still spells out ${item.found.join(", ")} — add it to "tokens" or fix the doc`,
      );
      continue;
    }
    if (item.kind === "subject") {
      lines.push(`  [subject]   ${item.templateId}`);
      lines.push(`      - code: ${item.code}`);
      lines.push(`      + doc:  ${item.doc}`);
      continue;
    }
    lines.push(`  [body]      ${item.templateId}`);
    lines.push(...renderBodyDiff(item.doc, item.code));
  }
  return lines.join("\n");
}

function resolveGogBinary(): string {
  // Same fallback as the guidebook sync: the systemd unit runs with a PATH that misses ~/.local/bin.
  const userGog = path.join(os.homedir(), ".local", "bin", "gog");
  return process.env.GOG_BIN ?? (fs.existsSync(userGog) ? userGog : "gog");
}

async function fetchDocument(documentId: string): Promise<string> {
  const account = process.env.GOG_ACCOUNT?.trim();
  if (!account) {
    throw new Error(
      "GOG_ACCOUNT is not set. Source the AdminBot env file first: set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a",
    );
  }
  const { stdout } = await execFileAsync(
    resolveGogBinary(),
    ["docs", "cat", "--raw", "--account", account, documentId],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

export async function main(argv: string[]): Promise<number> {
  const asJson = argv.includes("--json");
  const fromIndex = argv.indexOf("--from");
  const map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8")) as TemplateMap;
  const raw =
    fromIndex >= 0
      ? fs.readFileSync(argv[fromIndex + 1] as string, "utf8")
      : await fetchDocument(map.documentId);
  const markdown = renderDocsDocumentAsMarkdown(parseDocsJson(raw));
  const docTemplates = parseTemplateDoc(markdown);
  const drift = compareTemplates({
    docTemplates,
    codeTemplates: ADMINBOT_ONBOARDING_TEMPLATES,
    map,
  });
  if (asJson) {
    console.log(
      JSON.stringify({ parsed: docTemplates.length, drift }, null, 2),
    );
  } else {
    console.log(`parsed ${docTemplates.length} template(s) from the doc`);
    console.log(renderReport(drift));
  }
  return drift.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exitCode = 2;
    });
}
