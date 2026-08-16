/**
 * Splits an exported Google Doc into retrieval chunks along its heading structure.
 *
 * Headings carry most of the guidebook's meaning — "Reimbursements > Conference
 * travel > Receipts" tells the reader more than the paragraph often does — so
 * chunks keep their heading trail and are cited by it rather than by page number,
 * which a Docs export does not preserve.
 */
import type { GuidebookChunk } from "./types.js";

/** Target chunk size in characters. Large enough to hold a whole procedure, small
 *  enough that a handful fit in the local model's context alongside the question. */
const TARGET_CHARS = 1_400;
/** Never emit a chunk shorter than this on its own; fold it into the next one. */
const MIN_CHARS = 200;

const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/u;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
}

function headingTrail(stack: string[]): string {
  return stack.filter(Boolean).join(" > ");
}

/** Splits a long section on paragraph boundaries so no chunk blows the context budget. */
function splitOversizedSection(body: string): string[] {
  const paragraphs = body.split(/\n{2,}/u).filter((part) => part.trim());
  const parts: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > TARGET_CHARS && current) {
      parts.push(current);
      current = paragraph;
      continue;
    }
    current = candidate;
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

/** Turns exported markdown into heading-scoped chunks, without embeddings. */
export function chunkGuidebookMarkdown(markdown: string): Array<Omit<GuidebookChunk, "vector">> {
  const stack: string[] = [];
  const sections: Array<{ headings: string[]; body: string }> = [];
  let body = "";

  const flush = () => {
    if (body.trim()) {
      sections.push({ headings: [...stack], body: body.trim() });
    }
    body = "";
  };

  for (const line of markdown.split(/\r?\n/u)) {
    const heading = HEADING_PATTERN.exec(line);
    if (!heading) {
      body += `${line}\n`;
      continue;
    }
    flush();
    const depth = heading[1]?.length ?? 1;
    const title = heading[2] ?? "";
    stack.length = Math.max(0, depth - 1);
    stack[depth - 1] = title;
  }
  flush();

  const chunks: Array<Omit<GuidebookChunk, "vector">> = [];
  for (const section of sections) {
    const label = headingTrail(section.headings) || "Untitled section";
    const parts =
      section.body.length > TARGET_CHARS ? splitOversizedSection(section.body) : [section.body];
    for (const [index, part] of parts.entries()) {
      const previous = chunks.at(-1);
      // A stray one-liner under its own heading retrieves badly on its own; give it
      // to the previous chunk instead so the surrounding procedure stays intact.
      if (part.length < MIN_CHARS && previous && index === 0) {
        previous.text = `${previous.text}\n\n${label}\n${part}`;
        continue;
      }
      chunks.push({
        id: `${slugify(label) || "section"}-${chunks.length}`,
        headings: section.headings.filter(Boolean),
        label: parts.length > 1 ? `${label} (${index + 1}/${parts.length})` : label,
        // The heading trail rides along in the embedded text: it is often the only
        // place a term like "per diem" appears near the paragraph that explains it.
        text: `${label}\n\n${part}`,
      });
    }
  }
  return chunks;
}
