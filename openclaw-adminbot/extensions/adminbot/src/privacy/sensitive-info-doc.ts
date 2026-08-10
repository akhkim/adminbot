import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type AdminBotSensitiveInfoRecord = {
  markdown: string;
  path?: string;
};

export type AdminBotSensitiveInfoDocument = {
  get(): Promise<AdminBotSensitiveInfoRecord>;
  update(markdown: string): Promise<AdminBotSensitiveInfoRecord>;
  listSensitiveTerms(): Promise<string[]>;
};

export type AdminBotSensitiveInfoDocumentOptions = {
  filePath?: string;
};

const DEFAULT_SENSITIVE_INFO_MARKDOWN = `# AdminBot Sensitive Information

This file defines the kinds of information that should be treated as sensitive by default.
Edit it in the AdminBot UI when the lab's privacy boundaries change.

## What counts as sensitive

- API keys, access tokens, passwords, private keys, session secrets
- Personal email addresses, phone numbers, home addresses, exact birth dates
- Government identifiers such as passport numbers or SSNs
- Financial information, reimbursement details, payroll, banking, tax forms
- Medical, health, disability, or accommodation information
- Legal, disciplinary, HR, hiring, recommendation, or evaluation material
- Unpublished paper drafts, reviewer comments, confidential collaboration notes
- Private calendar details, meeting links, invitee lists, and internal logistics
- Any data the user explicitly labels as private, confidential, or sensitive

## Sensitive terms and phrases

- api key
- access token
- password
- private key
- secret
- reimbursement
- ssn
- passport
- payroll
- medical
- recommendation letter
- confidential draft
- unpublished paper

## Notes

- Keep examples generic when possible.
- Add lab-specific phrases here if AdminBot should route them through the private path by default.
`;

export function createAdminBotSensitiveInfoDocument(
  options: AdminBotSensitiveInfoDocumentOptions = {},
): AdminBotSensitiveInfoDocument {
  let inMemory = normalizeMarkdown(DEFAULT_SENSITIVE_INFO_MARKDOWN);
  const filePath = options.filePath?.trim() ? path.resolve(options.filePath) : undefined;
  return {
    async get() {
      const markdown = await loadMarkdown(filePath, inMemory);
      inMemory = markdown;
      return { markdown, ...(filePath ? { path: filePath } : {}) };
    },
    async update(markdown) {
      const next = normalizeMarkdown(markdown);
      if (!next.trim()) {
        throw new Error("sensitive information markdown is required");
      }
      inMemory = next;
      if (filePath) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, next, "utf8");
      }
      return { markdown: next, ...(filePath ? { path: filePath } : {}) };
    },
    async listSensitiveTerms() {
      const markdown = await loadMarkdown(filePath, inMemory);
      inMemory = markdown;
      return extractSensitiveTerms(markdown);
    },
  };
}

async function loadMarkdown(filePath: string | undefined, fallback: string): Promise<string> {
  if (!filePath) {
    return fallback;
  }
  try {
    return normalizeMarkdown(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fallback, "utf8");
    return fallback;
  }
}

function normalizeMarkdown(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return `${normalized}\n`;
}

function extractSensitiveTerms(markdown: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const rawLine of markdown.split("\n")) {
    const match = /^\s*[-*]\s+(.+?)\s*$/u.exec(rawLine);
    if (!match) {
      continue;
    }
    const term = match[1].trim();
    const key = term.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms;
}
