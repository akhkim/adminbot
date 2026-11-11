// The references a LaTeX paper cites, read from its own source rather than out of PDF text.
//
// The PDF reference checker has to find the References heading in extracted text and split it into
// entries, and it refuses a paper whose bibliography it cannot split reliably -- the most common
// reason a check fails. A PaperMentor upload carries the source, which already has every entry
// separated and labelled, so for it the check reads the entries the paper actually cites (an
// uncited entry in a shared .bib is not the paper's problem).
//
// A .bib entry goes to the lookup as its own fields -- title, authors, year, venue -- so nothing is
// re-parsed out of a citation string; the ACL-style rendering ("Authors. Year. Title. In Venue.")
// is only what the finding shows, and carries the DOI or arXiv ID the lookup resolves directly. A
// paper that writes its bibliography by hand (`thebibliography`, or a committed `.bbl`) has no
// fields to read, so each `\bibitem` goes as its printed text -- still one entry per item, never a
// split of PDF text.
//
// Deliberately small: entries, fields, braces, quotes, `#` concatenation and @string macros. Not a
// full BibTeX implementation; an entry it cannot read is counted as skipped, never guessed at.
import fs from "node:fs";
import path from "node:path";
import type { ReferenceEntry, StructuredReference } from "./reference-check.js";

export type BibReferences = {
  /**
   * One entry per cited reference with a title, in the order the paper first cites them: a .bib
   * entry's fields, or a \bibitem's text. Uncited \bibitems follow, since LaTeX prints every one.
   */
  references: ReferenceEntry[];
  /** Distinct keys the .tex files cite (every .bib entry, with \nocite{*}). */
  cited: number;
  /** Cited keys with no entry in any .bib or \bibitem list, or an entry without a title. */
  skipped: number;
};

type BibEntry = { type: string; key: string; fields: Record<string, string> };

const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * The cited entries of the paper in `dir`, or undefined when its source holds none to read (no
 * .bib or \bibitem list, or no cited key resolves). There is no PDF fallback: a reference split out
 * of PDF text is exactly what this exists to avoid.
 */
export function citedBibReferences(dir: string): BibReferences | undefined {
  const { tex, bib, bbl } = sourceFiles(dir);
  const strings = new Map<string, string>(MONTHS);
  const entries = new Map<string, BibEntry>();
  for (const file of bib) {
    for (const entry of parseBib(file, strings)) {
      // BibTeX keeps the first of two entries with one key and warns about the second.
      if (!entries.has(entry.key.toLowerCase())) {
        entries.set(entry.key.toLowerCase(), entry);
      }
    }
  }
  const items = new Map<string, string>();
  for (const file of [...tex, ...bbl]) {
    for (const [key, text] of bibItems(file)) {
      if (!items.has(key)) {
        items.set(key, text);
      }
    }
  }
  if (!entries.size && !items.size) {
    return undefined;
  }
  const { keys, all } = citedKeys(tex);
  const citedOrder = all ? [...new Set([...keys, ...entries.keys()])] : keys;
  // Every \bibitem is printed whether or not it is cited, so each is the paper's reference.
  const order = [...new Set([...citedOrder, ...items.keys()])];
  const references: ReferenceEntry[] = [];
  let skipped = 0;
  for (const key of order) {
    // The .bib entry wins over a \bibitem for the same key: a committed .bbl is usually its output.
    const entry = entries.get(key);
    const reference = entry ? bibReference(entry) : items.get(key);
    if (reference) {
      references.push(reference);
    } else {
      skipped += 1;
    }
  }
  return references.length ? { references, cited: citedOrder.length, skipped } : undefined;
}

/**
 * The `\bibitem`s of every `thebibliography` in one file, as [lowercased key, printed text]. The
 * label argument (`\bibitem[Smith et al.(2020)]{key}`) is skipped; the text is the item's TeX with
 * the markup taken out, which is what the lookup's citation parser reads.
 */
export function bibItems(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const body = withoutComments(text);
  const blocks = body.matchAll(
    /\\begin\s*\{thebibliography\}([\s\S]*?)(?:\\end\s*\{thebibliography\}|$)/gu,
  );
  for (const block of blocks) {
    const parts = block[1].split(/\\bibitem\s*(?:\[(?:[^[\]]|\[[^\]]*\])*\])?\s*\{([^}]*)\}/u);
    // split with one capture group: [preamble, key1, text1, key2, text2, ...]
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const key = parts[i].trim().toLowerCase();
      const printed = plainTex(parts[i + 1]);
      if (key && printed) {
        out.push([key, printed]);
      }
    }
  }
  return out;
}

function sourceFiles(dir: string): { tex: string[]; bib: string[]; bbl: string[] } {
  const tex: string[] = [];
  const bib: string[] = [];
  const bbl: string[] = [];
  let bytes = 0;
  const walk = (current: string, depth: number) => {
    if (depth > 8 || tex.length + bib.length >= MAX_FILES) {
      return;
    }
    // Sorted, so first-cited order does not depend on the filesystem's directory order.
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // papermentor's own output folder and anything hidden are not the paper.
      if (entry.name.startsWith(".") || (depth === 0 && entry.name === "papermentor")) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && /\.(tex|bib|bbl)$/iu.test(entry.name)) {
        bytes += fs.statSync(full).size;
        if (bytes > MAX_BYTES) {
          return;
        }
        const extension = entry.name.slice(-4).toLowerCase();
        (extension === ".bib" ? bib : extension === ".bbl" ? bbl : tex).push(
          fs.readFileSync(full, "utf8"),
        );
      }
    }
  };
  walk(dir, 0);
  return { tex, bib, bbl };
}

/** Keys in first-cited order, lowercased (BibTeX keys are case-insensitive). */
export function citedKeys(texFiles: readonly string[]): { keys: string[]; all: boolean } {
  const keys: string[] = [];
  const seen = new Set<string>();
  let all = false;
  // \cite, \citet, \citep*, \parencite, \textcite, \autocite, \nocite, \citeauthor, ... with up to
  // two optional arguments before the keys.
  const pattern = /\\[A-Za-z]*cite[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/gu;
  for (const text of texFiles) {
    for (const match of withoutComments(text).matchAll(pattern)) {
      for (const raw of match[1]!.split(",")) {
        const key = raw.trim().toLowerCase();
        if (key === "*") {
          all = true;
        } else if (key && !seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
  }
  return { keys, all };
}

function withoutComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gmu, "$1");
}

const MONTHS: ReadonlyArray<[string, string]> = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
].map((month) => [month, month]);

/** Every entry in one .bib text. @string macros are added to `strings` as they are read. */
export function parseBib(text: string, strings = new Map<string, string>(MONTHS)): BibEntry[] {
  const entries: BibEntry[] = [];
  let at = 0;
  while ((at = text.indexOf("@", at)) !== -1) {
    const head = /^@\s*([A-Za-z]+)\s*([{(])/u.exec(text.slice(at, at + 64));
    if (!head) {
      at += 1;
      continue;
    }
    const type = head[1]!.toLowerCase();
    const close = head[2] === "{" ? "}" : ")";
    let pos = at + head[0].length;
    if (type === "comment" || type === "preamble") {
      at =
        close === "}"
          ? (skipBalanced(text, pos - 1) ?? text.length)
          : text.indexOf(")", pos) + 1 || text.length;
      continue;
    }
    if (type === "string") {
      const field = readField(text, pos, strings);
      if (field) {
        strings.set(field.name, field.value);
        pos = field.end;
      }
      at = pos + 1;
      continue;
    }
    const comma = text.indexOf(",", pos);
    if (comma === -1) {
      break;
    }
    const key = text.slice(pos, comma).trim();
    pos = comma + 1;
    const fields: Record<string, string> = {};
    // Fields until the entry's closing delimiter; a malformed field ends the entry.
    while (pos < text.length) {
      pos = skipSpace(text, pos);
      if (text[pos] === close) {
        pos += 1;
        break;
      }
      const field = readField(text, pos, strings);
      if (!field) {
        break;
      }
      fields[field.name] = field.value;
      pos = skipSpace(text, field.end);
      if (text[pos] === ",") {
        pos += 1;
      }
    }
    if (key && !/\s/u.test(key)) {
      entries.push({ type, key, fields });
    }
    at = pos;
  }
  return entries;
}

function readField(
  text: string,
  start: number,
  strings: Map<string, string>,
): { name: string; value: string; end: number } | undefined {
  const name = /^\s*([A-Za-z][\w:-]*)\s*=\s*/u.exec(text.slice(start, start + 200));
  if (!name) {
    return undefined;
  }
  let pos = start + name[0].length;
  const parts: string[] = [];
  while (pos < text.length) {
    pos = skipSpace(text, pos);
    const char = text[pos];
    if (char === "{") {
      const end = skipBalanced(text, pos);
      if (end === undefined) {
        return undefined;
      }
      parts.push(text.slice(pos + 1, end - 1));
      pos = end;
    } else if (char === '"') {
      let end = pos + 1;
      let depth = 0;
      while (end < text.length && !(text[end] === '"' && depth === 0)) {
        depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0;
        end += 1;
      }
      parts.push(text.slice(pos + 1, end));
      pos = end + 1;
    } else {
      const bare = /^[\w:.+/-]+/u.exec(text.slice(pos, pos + 200));
      if (!bare) {
        return undefined;
      }
      parts.push(strings.get(bare[0].toLowerCase()) ?? bare[0]);
      pos += bare[0].length;
    }
    pos = skipSpace(text, pos);
    if (text[pos] !== "#") {
      break;
    }
    pos += 1;
  }
  return { name: name[1]!.toLowerCase(), value: parts.join(""), end: pos };
}

/** The index just past the brace group opening at `start`, or undefined if it never closes. */
function skipBalanced(text: string, start: number): number | undefined {
  let depth = 0;
  for (let pos = start; pos < text.length; pos += 1) {
    if (text[pos] === "\\") {
      pos += 1;
    } else if (text[pos] === "{") {
      depth += 1;
    } else if (text[pos] === "}") {
      depth -= 1;
      if (depth === 0) {
        return pos + 1;
      }
    }
  }
  return undefined;
}

function skipSpace(text: string, start: number): number {
  let pos = start;
  while (pos < text.length && /\s/u.test(text[pos]!)) {
    pos += 1;
  }
  return pos;
}

/** A field's value as a reader sees it: no braces, accents folded, commands dropped. */
export function plainTex(value: string): string {
  return (
    value
      .replace(/\\(?:url|href)\s*\{([^}]*)\}(?:\{([^}]*)\})?/gu, (_m, url, label) => label ?? url)
      // Symbol accents (\'e, \"{u}) take the letter straight after; letter accents (\c{c}, \v s)
      // only when the command name ends there, so \textsc and \vspace are not read as accents.
      .replace(/\\[`'^"~=.]\s*\{?\s*([A-Za-z])\}?/gu, "$1")
      .replace(/\\[uvHtcdbk](?![A-Za-z])\s*\{?\s*([A-Za-z])\}?/gu, "$1")
      .replace(/\\(?:ss)\b/gu, "ss")
      .replace(/\\([&%$#_])/gu, "$1")
      .replace(/\\[A-Za-z]+\*?\s*/gu, "")
      .replace(/[{}$]/gu, "")
      .replace(/~/gu, " ")
      .replace(/---?/gu, "–")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function authorList(field: string | undefined): string {
  if (!field) {
    return "";
  }
  const names = plainTex(field.replace(/\s+/gu, " "))
    .split(/\s+and\s+/iu)
    .map((name) => name.trim())
    .filter((name) => name && name.toLowerCase() !== "others")
    .map((name) => {
      const parts = name.split(",").map((part) => part.trim());
      // "Last, First" and "Last, Jr., First" both read "First Last".
      return parts.length >= 2 ? `${parts.at(-1)} ${parts[0]}`.trim() : name;
    });
  if (names.length > 8) {
    return `${names.slice(0, 3).join(", ")}, et al`;
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return names.length > 2
    ? `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
    : (names[0] ?? "");
}

/** The fields the lookup matches on, read once for both the structured entry and its rendering. */
function bibFields(entry: BibEntry) {
  const f = entry.fields;
  const title = plainTex(f.title ?? "").replace(/[.\s]+$/u, "");
  if (!title) {
    return undefined;
  }
  const arxiv =
    (f.archiveprefix ?? f.eprinttype ?? "").toLowerCase() === "arxiv" && f.eprint
      ? `arXiv preprint arXiv:${f.eprint.trim()}`
      : undefined;
  return {
    title,
    authors: authorList(f.author ?? f.editor),
    year: /\b(1[89]\d{2}|20\d{2})\b/u.exec(f.year ?? f.date ?? "")?.[1],
    venue: plainTex(
      f.booktitle ?? f.journal ?? f.journaltitle ?? f.school ?? f.institution ?? arxiv ?? "",
    ),
    doi: /10\.\d{4,9}\/\S+/u.exec(f.doi ?? "")?.[0],
  };
}

/** One entry as an ACL-style citation, or undefined for one with no title to look up. */
export function renderCitation(entry: BibEntry): string | undefined {
  const fields = bibFields(entry);
  if (!fields) {
    return undefined;
  }
  // Digits in the author segment would stop a parser reading the leading names as authors.
  const authors = fields.authors.replace(/\d+/gu, "");
  const head = [authors || "Anonymous", fields.year].filter(Boolean).join(". ");
  return [
    `${head}. ${fields.title}.`,
    fields.venue ? ` ${entry.type === "inproceedings" ? "In " : ""}${fields.venue}.` : "",
    fields.doi ? ` DOI: ${fields.doi}` : "",
  ].join("");
}

/**
 * One entry as the lookup takes it: its own fields, plus the rendered citation the finding shows
 * (and the lookup reads a DOI or arXiv ID from). Undefined for an entry with no title.
 */
export function bibReference(entry: BibEntry): StructuredReference | undefined {
  const fields = bibFields(entry);
  const citation = renderCitation(entry);
  if (!fields || !citation) {
    return undefined;
  }
  return {
    citation,
    title: fields.title,
    ...(fields.authors ? { authors: fields.authors } : {}),
    ...(fields.year ? { year: fields.year } : {}),
    ...(fields.venue ? { venue: fields.venue } : {}),
  };
}
