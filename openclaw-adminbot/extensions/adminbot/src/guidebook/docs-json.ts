/**
 * Converts a Google Docs API document into the markdown the chunker expects.
 *
 * The obvious route — `gog docs export --format md` — goes through Drive's
 * `files.export`, which refuses anything whose converted form exceeds 10 MB. A
 * 100-page guidebook does. `documents.get` has no such cap, and its JSON carries
 * the heading levels explicitly, so reconstructing markdown from it is both more
 * robust and more faithful than parsing an exported file.
 */

type DocsTextRun = { content?: unknown };
type DocsParagraphElement = { textRun?: DocsTextRun };
type DocsParagraph = {
  elements?: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: unknown };
  bullet?: unknown;
};
type DocsTableCell = { content?: DocsStructuralElement[] };
type DocsTableRow = { tableCells?: DocsTableCell[] };
type DocsStructuralElement = {
  paragraph?: DocsParagraph;
  table?: { tableRows?: DocsTableRow[] };
};
type DocsTab = {
  documentTab?: { body?: { content?: DocsStructuralElement[] } };
  childTabs?: DocsTab[];
  tabProperties?: { title?: unknown };
};

export type DocsDocument = {
  title?: unknown;
  body?: { content?: DocsStructuralElement[] };
  tabs?: DocsTab[];
};

const HEADING_LEVELS: Record<string, number> = {
  TITLE: 1,
  SUBTITLE: 2,
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

function paragraphText(paragraph: DocsParagraph): string {
  return (paragraph.elements ?? [])
    .map((element) => (typeof element.textRun?.content === "string" ? element.textRun.content : ""))
    .join("")
    .replace(/\v/gu, "\n")
    .trimEnd();
}

function renderParagraph(paragraph: DocsParagraph): string {
  const text = paragraphText(paragraph);
  if (!text.trim()) {
    return "";
  }
  const style = paragraph.paragraphStyle?.namedStyleType;
  const level = typeof style === "string" ? HEADING_LEVELS[style] : undefined;
  if (level) {
    return `${"#".repeat(level)} ${text.trim()}`;
  }
  // List items keep a marker so a procedure's steps stay visibly ordered in the
  // chunk the model reads.
  return paragraph.bullet ? `- ${text.trim()}` : text;
}

function renderElements(elements: DocsStructuralElement[]): string[] {
  const blocks: string[] = [];
  for (const element of elements) {
    if (element.paragraph) {
      const rendered = renderParagraph(element.paragraph);
      if (rendered) {
        blocks.push(rendered);
      }
      continue;
    }
    const rows = element.table?.tableRows;
    if (!rows) {
      continue;
    }
    // Tables carry real content in a guidebook — deadlines, amounts, contacts —
    // so flatten each row to a pipe-joined line rather than dropping it.
    for (const row of rows) {
      const cells = (row.tableCells ?? []).map((cell) =>
        renderElements(cell.content ?? [])
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim(),
      );
      if (cells.some(Boolean)) {
        blocks.push(cells.join(" | "));
      }
    }
  }
  return blocks;
}

function collectTabs(tabs: DocsTab[], into: Array<{ title: string; blocks: string[] }>): void {
  for (const tab of tabs) {
    const content = tab.documentTab?.body?.content;
    if (content?.length) {
      const title = typeof tab.tabProperties?.title === "string" ? tab.tabProperties.title : "";
      into.push({ title, blocks: renderElements(content) });
    }
    if (tab.childTabs?.length) {
      collectTabs(tab.childTabs, into);
    }
  }
}

/** Renders a `documents.get` payload as markdown. */
export function renderDocsDocumentAsMarkdown(document: DocsDocument): string {
  const sections: string[] = [];
  if (document.tabs?.length) {
    const tabs: Array<{ title: string; blocks: string[] }> = [];
    collectTabs(document.tabs, tabs);
    for (const tab of tabs) {
      // A tab title is a real structural boundary, so promote it to a top-level
      // heading; without it every tab's sections would collide in the trail.
      if (tab.title.trim()) {
        sections.push(`# ${tab.title.trim()}`);
      }
      sections.push(...tab.blocks);
    }
  }
  if (sections.length === 0) {
    sections.push(...renderElements(document.body?.content ?? []));
  }
  return sections.join("\n\n");
}

/** Pulls the document out of whatever envelope gog wrapped it in. */
export function parseDocsJson(raw: string): DocsDocument {
  const parsed = JSON.parse(raw) as unknown;
  const candidates: unknown[] = [parsed];
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    candidates.push(record.result, record.document, record.data);
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const document = candidate as DocsDocument;
    if (document.body?.content || document.tabs?.length) {
      return document;
    }
  }
  throw new Error("gog returned JSON without a Docs body; is --raw supported by this gog build?");
}
