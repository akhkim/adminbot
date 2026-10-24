// Adapted from References-Validation; see NOTICE.md and LICENSE.
import { XMLParser } from "fast-xml-parser";
import { referenceFetch as fetch } from "../../connectors/reference-check.http.js";
/**
 * arXiv API Service
 * Searches for papers using the arXiv public API (Atom XML)
 * No API key required. Rate limit: reasonable usage expected.
 *
 * This service is used as a FALLBACK — only queried when CrossRef,
 * Semantic Scholar, and OpenAlex all fail to find a match.
 */

export interface ArxivResult {
  id: string; // arXiv ID (e.g., "2301.12345")
  title: string;
  authors: string[];
  year: number | null;
  category: string; // Primary category (e.g., "cs.CL")
  doi: string | null;
  url: string; // abs link
  pdfUrl: string; // pdf link
}

/**
 * Simple title similarity for best-match selection (same logic as SS/OA services)
 */
const titleSimilarity = (a: string, b: string): number => {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .trim();
  const ca = clean(a);
  const cb = clean(b);
  if (ca === cb) {
    return 100;
  }
  const wordsA = new Set(ca.split(/\s+/));
  const wordsB = new Set(cb.split(/\s+/));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) {
      overlap++;
    }
  }
  const maxLen = Math.max(wordsA.size, wordsB.size);
  return maxLen > 0 ? Math.round((overlap / maxLen) * 100) : 0;
};

/**
 * Parse the Atom XML response from arXiv API
 */
const parseArxivResponse = (xml: string): ArxivResult[] => {
  type AtomEntry = {
    title?: string;
    id?: string;
    published?: string;
    doi?: string;
    author?: { name?: string } | { name?: string }[];
    primary_category?: { "@_term"?: string };
  };
  const doc = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml) as {
    feed?: { entry?: AtomEntry | AtomEntry[] };
  };
  const entries = doc.feed?.entry;
  const list = entries ? (Array.isArray(entries) ? entries : [entries]) : [];
  const results: ArxivResult[] = list
    .filter((e) => e.title && e.id)
    .map((e) => {
      const authors = e.author ? (Array.isArray(e.author) ? e.author : [e.author]) : [];
      const id = String(e.id).split("/abs/")[1]?.replace(/v\d+$/, "") ?? "";
      return {
        id,
        title: String(e.title).replace(/\s+/g, " ").trim(),
        authors: authors.map((a) => a.name ?? ""),
        year: Number.parseInt(String(e.published), 10) || null,
        category: e.primary_category?.["@_term"] ?? "",
        doi: e.doi ?? null,
        url: `https://arxiv.org/abs/${id}`,
        pdfUrl: `https://arxiv.org/pdf/${id}`,
      };
    });
  return results;
};

/**
 * Search arXiv for a paper by title.
 * @param title - The paper title to search for
 * @param expectedYear - Optional expected year to prefer the correct version
 * @returns The best matching paper or null
 */
export const searchArxiv = async (
  title: string,
  expectedYear?: string,
): Promise<ArxivResult | null> => {
  try {
    // Use ti: prefix to search specifically in titles
    // Also do an all: search for better recall with messy queries
    const encodedQuery = encodeURIComponent(title);

    const apiUrl = `https://export.arxiv.org/api/query?search_query=ti:${encodedQuery}&max_results=5&sortBy=relevance&sortOrder=descending`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      return null;
    }

    const xmlText = await response.text();
    const papers = parseArxivResponse(xmlText);

    if (papers.length === 0) {
      return null;
    }

    // Pick the best match by title similarity + year preference
    let bestPaper = papers[0];
    let bestScore = -1;

    for (const paper of papers) {
      let score = titleSimilarity(title, paper.title);

      // Boost score if year matches expected
      if (expectedYear && paper.year) {
        if (paper.year.toString() === expectedYear) {
          score += 20; // Strong boost for exact year match
        } else if (Math.abs(paper.year - Number.parseInt(expectedYear, 10)) === 1) {
          score += 5; // Small boost for ±1 year
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestPaper = paper;
      }
    }

    return bestPaper;
  } catch {
    return null;
  }
};

/**
 * Resolve a paper directly by arXiv ID (e.g., "2301.12345").
 * Uses the id_list parameter for exact, instant lookup.
 * @param arxivId - The arXiv ID to resolve
 * @returns The paper or null
 */
export const resolveArxivById = async (arxivId: string): Promise<ArxivResult | null> => {
  try {
    const cleanId = arxivId
      .replace(/^arXiv:/i, "")
      .replace(/v\d+$/, "")
      .trim();

    const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;

    const response = await fetch(apiUrl);
    if (!response.ok) {
      return null;
    }

    const xmlText = await response.text();
    const papers = parseArxivResponse(xmlText);

    return papers.length > 0 ? papers[0] : null;
  } catch {
    return null;
  }
};

// ===== CITATION FORMATTERS =====

/**
 * Format an arXiv result to APA citation
 */
export const formatArxivAPA = (paper: ArxivResult): string => {
  const authors = paper.authors
    .map((name, idx) => {
      const parts = name.split(" ");
      const lastName = parts.pop() || "";
      const initials = parts.map((p) => p[0] + ".").join(" ");
      return idx === paper.authors.length - 1 && paper.authors.length > 1
        ? `& ${lastName}, ${initials}`
        : `${lastName}, ${initials}`;
    })
    .join(", ");

  const year = paper.year || "n.d.";
  const doi = paper.doi ? `https://doi.org/${paper.doi}` : "";

  let citation = `${authors} (${year}). ${paper.title}.`;
  citation += ` arXiv preprint arXiv:${paper.id}.`;
  if (doi) {
    citation += ` ${doi}`;
  } else {
    citation += ` ${paper.url}`;
  }
  return citation;
};

/**
 * Format an arXiv result to MLA citation
 */
export const formatArxivMLA = (paper: ArxivResult): string => {
  let authorsStr = "";
  const authors = paper.authors;
  if (authors.length === 1) {
    authorsStr = authors[0];
  } else if (authors.length === 2) {
    authorsStr = `${authors[0]} and ${authors[1]}`;
  } else if (authors.length > 2) {
    authorsStr = `${authors[0]}, et al`;
  }

  if (authorsStr && !authorsStr.endsWith(".")) {
    authorsStr += ".";
  }

  const year = paper.year || "n.d.";
  const doi = paper.doi ? `https://doi.org/${paper.doi}` : paper.url;

  let citation = authorsStr ? `${authorsStr} ` : "";
  citation += `"${paper.title}."`;
  citation += ` arXiv preprint arXiv:${paper.id},`;
  citation += ` ${year}.`;
  if (doi) {
    citation += ` ${doi}.`;
  }

  return citation;
};

/**
 * Format an arXiv result to ISO 690 citation
 */
export const formatArxivISO690 = (paper: ArxivResult): string => {
  const authors = paper.authors.map((a) => a.toUpperCase()).join("; ");
  const year = paper.year || "n.d.";
  const doi = paper.doi ? `https://doi.org/${paper.doi}` : paper.url;

  let citation = authors ? `${authors}. ` : "";
  citation += `${paper.title}.`;
  citation += ` arXiv preprint arXiv:${paper.id},`;
  citation += ` ${year}.`;
  if (doi) {
    citation += ` ${doi}`;
  }

  return citation;
};

/**
 * Generate BibTeX from an arXiv result
 */
export const generateArxivBibTeX = (paper: ArxivResult): string => {
  const authors = paper.authors.join(" and ");
  const year = paper.year || "n.d.";
  const firstAuthor = paper.authors[0]?.split(" ").pop() || "Unknown";
  const cleanTitle = paper.title.split(" ")[0].replace(/[^a-zA-Z0-9]/g, "");
  const id = `${firstAuthor}${year}${cleanTitle}`;

  let bib = `@misc{${id},
  title={${paper.title}},
  author={${authors}},
  year={${year}},
  eprint={${paper.id}},
  archivePrefix={arXiv}`;

  if (paper.category) {
    bib += `,\n  primaryClass={${paper.category}}`;
  }
  if (paper.doi) {
    bib += `,\n  doi={${paper.doi}}`;
  }

  bib += `\n}`;
  return bib;
};
