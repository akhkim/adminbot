/**
 * Deterministic reference verification, ported from PaperMentor's
 * `services/web/app/src/Features/Chat/CitationVerifier.mjs`
 * (https://github.com/jiarui-liu/overleaf).
 *
 * The thresholds, field comparisons, and verdict kinds are kept identical so both tools call the
 * same reference fabricated. Two things differ, both forced by the input:
 *
 *   - PaperMentor parses a project's .bib file. OpenReview only publishes compiled PDFs, so
 *     entries arrive here already extracted from the reference block (see
 *     `adminbot-pdf-references.py` and the local-model parse step). The entry shape is the same
 *     `{ key, fields: { title, author, year, doi, ... } }`, so everything below is unchanged.
 *   - PaperMentor requires SEMANTIC_SCHOLAR_API_KEY. There is no such key here, and keyless S2
 *     rate-limits immediately, so Crossref and OpenAlex back it up. Every provider maps into the
 *     S2 paper shape, which is what the comparison logic reads.
 *
 * The rule that a transient lookup failure yields `unverified` and never `fabricated` is load
 * bearing: the output of this accuses a colleague of inventing a citation, and an API blip must
 * never be able to produce that.
 */

const TITLE_MATCH_STRONG = 0.85;
const TITLE_MATCH_CANDIDATE = 0.7;
const YEAR_TOLERANCE_OK = 1;
const YEAR_TOLERANCE_WARN = 3;
// PaperMentor used 5. Measured against real submissions, 5 was itself a false-positive source:
// "Attention Is All You Need" only reached similarity 1.00 once the candidate set held 10.
const SEARCH_LIMIT = 10;

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS = "title,authors,year,venue,externalIds,publicationVenue";
const CROSSREF_BASE = "https://api.crossref.org/works";
const OPENALEX_BASE = "https://api.openalex.org/works";
// Must be https: the http:// endpoint silently returns an empty feed from this network.
const ARXIV_BASE = "https://export.arxiv.org/api/query";

// S2 enforces 1 request/second per key by source IP; 1100ms leaves a 10% margin for clock skew.
// Crossref and OpenAlex are far more generous but still expect a polite fixed pace.
const DEFAULT_INTERVAL_MS = 1100;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

const LATEX_COMMAND_RE = /\\[a-zA-Z]+\s*|[{}$]/g;
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Normalization and similarity
// ---------------------------------------------------------------------------

export function stripLatex(value) {
  return (value || "").replace(LATEX_COMMAND_RE, " ").replace(/\s+/g, " ").trim();
}

export function normalizeTitle(value) {
  return stripLatex(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(PUNCT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop the subtitle after the first colon, for a more lenient compare. */
export function titleMainPart(value) {
  const stripped = stripLatex(value);
  const colon = stripped.indexOf(":");
  return colon > 0 ? normalizeTitle(stripped.slice(0, colon)) : normalizeTitle(value);
}

export function normalizeAuthorName(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Surnames from a BibTeX-style author field: "Last, First and ..." or "First Last and ...". */
export function extractAuthorSurnames(authorField) {
  if (!authorField) {
    return [];
  }
  return stripLatex(authorField)
    .split(/\s+and\s+/i)
    .map((author) => {
      const trimmed = author.trim();
      if (trimmed.includes(",")) {
        return normalizeAuthorName(trimmed.split(",")[0]);
      }
      const parts = trimmed.split(/\s+/);
      return normalizeAuthorName(parts[parts.length - 1] || "");
    })
    .filter(Boolean);
}

export function normalizeVenue(value) {
  if (!value) {
    return "";
  }
  return stripLatex(value)
    .toLowerCase()
    .replace(/proceedings of (the )?/g, "")
    .replace(/the (\d+(st|nd|rd|th) )?(annual |international |conference on )+/g, " ")
    .replace(/conference on/g, " ")
    .replace(/\b(20|19)\d{2}\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VENUE_ACRONYMS = {
  iclr: ["international conference on learning representations", "iclr"],
  neurips: ["neural information processing systems", "nips", "neurips", "advances in neural"],
  icml: ["international conference on machine learning", "icml"],
  acl: ["association for computational linguistics", "acl", "annual meeting"],
  emnlp: ["empirical methods in natural language processing", "emnlp"],
  naacl: ["north american chapter", "naacl"],
  aaai: ["aaai conference on artificial intelligence", "aaai"],
  cvpr: ["computer vision and pattern recognition", "cvpr"],
  iccv: ["international conference on computer vision", "iccv"],
  eccv: ["european conference on computer vision", "eccv"],
  colm: ["conference on language modeling", "colm"],
  jmlr: ["journal of machine learning research", "jmlr"],
  arxiv: ["arxiv", "corr", "preprint"],
};

/** Lenient venue compare. Returns true/false, or null when either side is unusable. */
export function venuesAgree(entryVenue, recordVenue) {
  const rawEntry = stripLatex(entryVenue || "").toLowerCase();
  const rawRecord = stripLatex(recordVenue || "").toLowerCase();
  if (!rawEntry || !rawRecord) {
    return null;
  }

  // Acronym route compares raw strings: normalizeVenue strips the very words that identify a venue.
  for (const aliases of Object.values(VENUE_ACRONYMS)) {
    if (aliases.some((a) => rawEntry.includes(a)) && aliases.some((a) => rawRecord.includes(a))) {
      return true;
    }
  }

  const left = normalizeVenue(entryVenue || "");
  const right = normalizeVenue(recordVenue || "");
  if (!left || !right) {
    return null;
  }
  if (left === right || left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftTokens = new Set(left.split(" ").filter((t) => t.length > 2));
  const rightTokens = new Set(right.split(" ").filter((t) => t.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return null;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.5;
}

export function levenshtein(a, b) {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 });
  let current = Array.from({ length: b.length + 1 });
  for (let j = 0; j <= b.length; j++) {
    previous[j] = j;
  }
  for (let i = 0; i < a.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

export function titleSimilarity(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left.length || !right.length) {
    return 0;
  }
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length);
}

// ---------------------------------------------------------------------------
// Rate limiting and transport
// ---------------------------------------------------------------------------

/**
 * Process-wide FIFO scheduler. Reservations are stamped synchronously, so concurrent callers
 * serialize naturally: caller N waits (N-1) * intervalMs even if all N reserve in one tick.
 */
export class RateLimiter {
  constructor(intervalMs = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
    this.nextAvailableAt = 0;
  }

  acquire() {
    const now = Date.now();
    const slot = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = slot + this.intervalMs;
    const wait = slot - now;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  }

  /**
   * Push the next slot out after a 429, so every other in-flight caller in this process backs off
   * too. Without it one 429 buys pacing for the caller that got hit while the rest keep firing.
   */
  pauseFor(ms) {
    const target = Date.now() + ms;
    if (target > this.nextAvailableAt) {
      this.nextAvailableAt = target;
    }
  }
}

export function parseRetryAfter(header) {
  if (!header) {
    return null;
  }
  const seconds = Number.parseInt(header, 10);
  if (!Number.isNaN(seconds) && String(seconds) === String(header).trim()) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Full-jitter exponential backoff, so concurrent retries do not re-collide on the same wall. */
export function computeBackoffMs(attempt, random = Math.random) {
  return Math.floor(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
}

/**
 * One request with retry, as a closed result rather than a payload carrying sentinel keys:
 *   { status: "ok", body }         parsed JSON
 *   { status: "not-found" }        the provider affirmatively has no such record
 *   { status: "failed", transient) transient means "unreachable, treat as unknown"; callers must
 *                                  never turn that into a verdict
 */
async function requestJson(url, { headers = {}, limiter, fetchImpl, random } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (limiter) {
      await limiter.acquire();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(url, { headers, signal: controller.signal });
      if (response.status === 404) {
        return { status: "not-found" };
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
        const delay = retryAfter ?? computeBackoffMs(attempt, random);
        if (response.status === 429) {
          limiter?.pauseFor(delay);
        }
        if (attempt === MAX_RETRIES) {
          return { status: "failed", transient: true, error: `HTTP ${response.status}` };
        }
        await sleep(delay);
        continue;
      }
      if (!response.ok) {
        return { status: "failed", transient: false, error: `HTTP ${response.status}` };
      }
      return { status: "ok", body: await response.json() };
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        return {
          status: "failed",
          transient: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await sleep(computeBackoffMs(attempt, random));
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: "failed", transient: true, error: "retries exhausted" };
}

// ---------------------------------------------------------------------------
// Providers. Each returns candidate papers in the S2 shape, or null when the
// lookup could not be completed (transient) so no verdict is fabricated.
// ---------------------------------------------------------------------------

function crossrefToPaper(item) {
  return {
    title: Array.isArray(item.title) ? item.title[0] : item.title,
    authors: (item.author || []).map((a) => ({
      name: [a.given, a.family].filter(Boolean).join(" ").trim(),
    })),
    year: item.issued?.["date-parts"]?.[0]?.[0] ?? null,
    venue: item["container-title"]?.[0] || item.publisher || "",
    externalIds: item.DOI ? { DOI: item.DOI } : {},
  };
}

function openAlexToPaper(work) {
  return {
    title: work.display_name,
    authors: (work.authorships || []).map((a) => ({ name: a.author?.display_name || "" })),
    year: work.publication_year ?? null,
    venue: work.primary_location?.source?.display_name || "",
    externalIds: work.doi ? { DOI: String(work.doi).replace(/^https?:\/\/doi\.org\//, "") } : {},
  };
}

function arxivToPapers(xml) {
  const papers = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    if (!title) {
      continue;
    }
    const published = /<published>(\d{4})/.exec(entry)?.[1];
    const doi = /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(entry)?.[1];
    papers.push({
      title: title.replace(/\s+/g, " ").trim(),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => ({
        name: m[1].replace(/\s+/g, " ").trim(),
      })),
      year: published ? Number.parseInt(published, 10) : null,
      venue: "arXiv",
      externalIds: doi ? { DOI: doi.trim() } : {},
    });
  }
  return papers;
}

/**
 * Build the lookup functions the verifier needs.
 *
 * Provider order is a measured result, not a preference. Semantic Scholar leads when a key is
 * available because that is what PaperMentor tuned its thresholds against. Without one, arXiv
 * leads: the reference population in these submissions is NLP/ML, and Crossref's ACL Anthology
 * deposits are metadata-poor — `10.18653/v1/N19-1423` (the BERT paper) resolves in Crossref with
 * an *empty* title and is absent from OpenAlex, so a Crossref-led search reported one of the most
 * cited papers in the field as fabricated. arXiv's quoted-title search finds it exactly.
 *
 * `contactEmail` goes in the Crossref/OpenAlex polite-pool User-Agent.
 */
export function createLookup({ apiKey, contactEmail, fetchImpl, limiter, random } = {}) {
  const shared = limiter ?? new RateLimiter();
  const politeHeaders = contactEmail
    ? { "user-agent": `jinesis-adminbot/1.0 (mailto:${contactEmail})` }
    : {};
  const options = { limiter: shared, fetchImpl, random };

  async function s2SearchByTitle(title) {
    const url =
      `${S2_BASE}/paper/search?query=${encodeURIComponent(title)}` +
      `&limit=${SEARCH_LIMIT}&fields=${S2_FIELDS}`;
    const result = await requestJson(url, { ...options, headers: { "x-api-key": apiKey } });
    if (result.status === "not-found") {
      return [];
    }
    if (result.status === "failed") {
      return result.transient ? null : [];
    }
    return result.body?.data ?? [];
  }

  async function crossrefSearchByTitle(title) {
    const url = `${CROSSREF_BASE}?query.bibliographic=${encodeURIComponent(title)}&rows=${SEARCH_LIMIT}`;
    const result = await requestJson(url, { ...options, headers: politeHeaders });
    if (result.status === "not-found") {
      return [];
    }
    if (result.status === "failed") {
      return result.transient ? null : [];
    }
    return (result.body?.message?.items ?? []).map(crossrefToPaper);
  }

  async function openAlexSearchByTitle(title) {
    const url = `${OPENALEX_BASE}?search=${encodeURIComponent(title)}&per-page=${SEARCH_LIMIT}`;
    const result = await requestJson(url, { ...options, headers: politeHeaders });
    if (result.status === "not-found") {
      return [];
    }
    if (result.status === "failed") {
      return result.transient ? null : [];
    }
    return (result.body?.results ?? []).map(openAlexToPaper);
  }

  async function arxivSearchByTitle(title) {
    // Quoted phrase against the title field only; a bare `all:` query is tokenized into ORs and
    // returns noise. Punctuation is dropped because arXiv's parser treats it as syntax.
    const phrase = title.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
    const url =
      `${ARXIV_BASE}?search_query=ti:${encodeURIComponent(`"${phrase}"`)}` +
      `&max_results=${SEARCH_LIMIT}`;
    const doFetch = fetchImpl ?? globalThis.fetch;
    await shared.acquire();
    try {
      const response = await doFetch(url, { headers: politeHeaders });
      if (!response.ok) {
        return response.status >= 500 ? null : [];
      }
      return arxivToPapers(await response.text());
    } catch {
      return null;
    }
  }

  /**
   * Union of every provider that answered. Returns null only when no provider completed, so the
   * caller can tell "nothing matches" from "we could not look".
   */
  async function searchByTitle(title) {
    const order = apiKey
      ? [s2SearchByTitle, arxivSearchByTitle, crossrefSearchByTitle, openAlexSearchByTitle]
      : [arxivSearchByTitle, crossrefSearchByTitle, openAlexSearchByTitle];
    const candidates = [];
    let anyCompleted = false;
    for (const search of order) {
      const hits = await search(title);
      if (hits === null) {
        continue;
      }
      anyCompleted = true;
      candidates.push(...hits);
      // A strong hit ends the walk; the remaining providers cannot improve on an exact match.
      if (hits.some((paper) => titleSimilarity(title, paper.title || "") >= TITLE_MATCH_STRONG)) {
        break;
      }
    }
    return anyCompleted ? candidates : null;
  }

  /**
   * Resolve DOIs one at a time into a Map<doi, paper|null>. A DOI absent from the map means the
   * lookup did not complete; `null` means the provider affirmatively has no such record. The
   * verifier depends on that distinction to avoid reporting doi_not_found for a transient miss.
   */
  async function lookupByDOIs(dois) {
    const resolved = new Map();
    for (const doi of dois) {
      const url = apiKey
        ? `${S2_BASE}/paper/DOI:${encodeURIComponent(doi)}?fields=${S2_FIELDS}`
        : `${CROSSREF_BASE}/${encodeURIComponent(doi)}`;
      const headers = apiKey ? { "x-api-key": apiKey } : politeHeaders;
      const result = await requestJson(url, { ...options, headers });
      if (result.status === "not-found") {
        resolved.set(doi, null);
        continue;
      }
      if (result.status === "failed") {
        continue;
      }
      resolved.set(doi, apiKey ? result.body : crossrefToPaper(result.body.message));
    }
    return resolved;
  }

  return {
    searchByTitle,
    lookupByDOIs,
    provider: apiKey ? "semantic-scholar" : "arxiv+crossref+openalex",
    // Only Semantic Scholar has coverage complete enough that "no candidate came back" is
    // evidence of fabrication rather than evidence of a gap. See verifyEntry.
    trustedAbsence: Boolean(apiKey),
  };
}

// ---------------------------------------------------------------------------
// Comparison and verdicts
// ---------------------------------------------------------------------------

/**
 * `strictMetadata` says whether the matched record's own fields can be trusted. With a Semantic
 * Scholar key they can, and this behaves exactly as PaperMentor does. Without one the records come
 * from arXiv/Crossref/OpenAlex, whose author lists and years are frequently wrong or edition-
 * specific, so two disagreements get demoted from critical to warning. Both demotions were
 * measured on a real submission: Ostrom's "Governing the Commons" matched by title at 1.00 while
 * Crossref listed its first author as "field", and Hayek's "Individualism and Economic Order"
 * differed only by reprint year (1980 vs 1996). Neither is a citation error.
 */
export function compareEntryToPaper(entry, paper, { strictMetadata = true } = {}) {
  const issues = [];
  const entryTitle = entry.fields.title || "";
  const titleSim = titleSimilarity(entryTitle, paper?.title || "");

  const entrySurnames = extractAuthorSurnames(entry.fields.author || "");
  const paperSurnames = (paper?.authors || [])
    .map((a) => {
      const parts = (a.name || "").trim().split(/\s+/);
      return normalizeAuthorName(parts[parts.length - 1] || "");
    })
    .filter(Boolean);
  if (entrySurnames.length > 0 && paperSurnames.length > 0) {
    const firstEntry = entrySurnames[0];
    const firstPaper = paperSurnames[0];
    if (firstEntry && firstPaper && firstEntry !== firstPaper) {
      const overlap = entrySurnames.filter((name) => paperSurnames.includes(name)).length;
      // A verbatim title means we have the right paper, so a disagreeing author list is far more
      // likely to be bad record metadata than a fabricated citation.
      const titleIsVerbatim = titleSim >= 0.95;
      if (overlap / Math.max(1, entrySurnames.length) < 0.5) {
        issues.push({
          field: "author",
          severity: !strictMetadata && titleIsVerbatim ? "warning" : "critical",
          detail: `reference first author "${firstEntry}" but the record lists "${firstPaper}"`,
        });
      } else {
        issues.push({
          field: "author",
          severity: "warning",
          detail: `first-author surname differs: "${firstEntry}" vs "${firstPaper}" (other authors do match)`,
        });
      }
    }
  }

  const entryYear = Number.parseInt(entry.fields.year, 10);
  const paperYear = paper?.year ? Number.parseInt(paper.year, 10) : null;
  if (Number.isFinite(entryYear) && Number.isFinite(paperYear)) {
    const diff = Math.abs(entryYear - paperYear);
    // Without a DOI we matched on title alone, and free records carry reprint/preprint years that
    // differ legitimately from the printed citation.
    const yearIsStrongEvidence = strictMetadata || Boolean((entry.fields.doi || "").trim());
    if (diff > YEAR_TOLERANCE_WARN) {
      issues.push({
        field: "year",
        severity: yearIsStrongEvidence ? "critical" : "warning",
        detail: `reference year ${entryYear} vs record year ${paperYear}`,
      });
    } else if (diff > YEAR_TOLERANCE_OK) {
      issues.push({
        field: "year",
        severity: "warning",
        detail: `reference year ${entryYear} vs record year ${paperYear}`,
      });
    }
  }

  const entryVenue = entry.fields.booktitle || entry.fields.journal || entry.fields.publisher || "";
  const paperVenue = paper?.publicationVenue?.name || paper?.venue || "";
  if (venuesAgree(entryVenue, paperVenue) === false) {
    issues.push({
      field: "venue",
      severity: "warning",
      detail: `reference venue "${entryVenue}" vs record venue "${paperVenue}"`,
    });
  }

  const entryDoi = (entry.fields.doi || "").toLowerCase().trim();
  const paperDoi = (paper?.externalIds?.DOI || "").toLowerCase().trim();
  if (entryDoi && paperDoi && entryDoi !== paperDoi) {
    issues.push({
      field: "doi",
      severity: "critical",
      detail: `reference DOI "${entryDoi}" vs record DOI "${paperDoi}"`,
    });
  }

  return { issues, titleSim };
}

/**
 * Decide one entry's verdict. `doiLookup` distinguishes "provider says no such DOI" (value null)
 * from "lookup never completed" (key absent) — only the former is reportable.
 */
export async function verifyEntry(entry, doiLookup, searchByTitle, { trustedAbsence = true } = {}) {
  const title = (entry.fields.title || "").trim();
  const doi = (entry.fields.doi || "").toLowerCase().trim();

  if (doi && doiLookup.has(doi)) {
    const paper = doiLookup.get(doi);
    if (paper === null) {
      return { kind: "doi_not_found" };
    }
    if (paper?.title) {
      if (title && titleSimilarity(title, paper.title) < 0.5) {
        return { kind: "doi_mismatch", paper };
      }
      const compared = compareEntryToPaper(entry, paper, { strictMetadata: trustedAbsence });
      return compared.issues.length === 0
        ? { kind: "verified", paper }
        : { kind: "mismatch", paper, issues: compared.issues };
    }
  }

  if (!title) {
    return { kind: "no_title" };
  }

  const candidates = await searchByTitle(title);
  if (candidates === null) {
    return { kind: "unverified", reason: "api_unavailable" };
  }
  if (candidates.length === 0) {
    // An empty result set is only evidence of fabrication when the provider is known to have the
    // literature. Without that, silence means "not indexed here" at least as often as "invented",
    // and this verdict is what tells a colleague they made a citation up.
    return trustedAbsence
      ? { kind: "fabricated", bestSim: 0, bestCandidate: null }
      : { kind: "unverified", reason: "no_candidates_untrusted" };
  }

  let best = null;
  let bestSim = 0;
  for (const candidate of candidates) {
    const sim = titleSimilarity(title, candidate.title || "");
    if (sim > bestSim) {
      bestSim = sim;
      best = candidate;
    }
  }

  if (bestSim < TITLE_MATCH_CANDIDATE) {
    const bestCandidate = best
      ? { title: best.title, year: best.year, venue: best.venue || best.publicationVenue?.name }
      : null;
    // Same reasoning as the empty-result case above, and measured the same way: on a real
    // submission this branch flagged Dewey's "Democracy and Education", Gini 1912, and the Gemini
    // 2.5 report, none of which arXiv/Crossref/OpenAlex index. A weak best match from an
    // incomplete index means "not in this index" at least as often as "invented", and only a
    // provider with real coverage earns the right to say the latter.
    return trustedAbsence
      ? { kind: "fabricated", bestSim, bestCandidate }
      : { kind: "unverified", reason: "no_match_untrusted", bestSim, bestCandidate };
  }

  const compared = compareEntryToPaper(entry, best, { strictMetadata: trustedAbsence });
  if (bestSim < TITLE_MATCH_STRONG) {
    if (compared.issues.length === 0) {
      return { kind: "unverified", reason: "borderline_match" };
    }
    // A title that only half-matches *and* fields that disagree is the signature of having
    // retrieved the wrong paper, not of a bad citation. With Semantic Scholar a borderline hit is
    // usually still the right record, so this only applies to the weaker providers: on a real
    // submission it matched Turner's 1982 "The determination of collective behaviour" to an
    // unrelated 2024 paper and reported the year gap as critical.
    if (!trustedAbsence) {
      return { kind: "unverified", reason: "wrong_candidate", bestSim, paper: best };
    }
    return { kind: "mismatch", paper: best, issues: compared.issues };
  }
  return compared.issues.length === 0
    ? { kind: "verified", paper: best }
    : { kind: "mismatch", paper: best, issues: compared.issues };
}

/** One human-readable finding per problem entry, or null when the entry is clean. */
export function describeVerdict(entry, verdict) {
  const label = entry.fields.title || entry.key || "(untitled reference)";
  if (verdict.kind === "verified" || verdict.kind === "no_title") {
    return null;
  }
  if (verdict.kind === "fabricated") {
    const closest = verdict.bestCandidate
      ? ` Closest match: "${verdict.bestCandidate.title}" (${verdict.bestCandidate.year ?? "no year"}).`
      : " No candidate came back at all.";
    return {
      severity: "critical",
      title: label,
      detail:
        `No matching record found (best title similarity ${verdict.bestSim.toFixed(2)}).` + closest,
    };
  }
  if (verdict.kind === "doi_not_found") {
    return {
      severity: "critical",
      title: label,
      detail: `DOI "${entry.fields.doi}" does not resolve to any record.`,
    };
  }
  if (verdict.kind === "doi_mismatch") {
    return {
      severity: "critical",
      title: label,
      detail: `DOI "${entry.fields.doi}" resolves to a different paper: "${verdict.paper.title}" (${verdict.paper.year ?? "no year"}).`,
    };
  }
  if (verdict.kind === "mismatch") {
    const severity = verdict.issues.some((i) => i.severity === "critical") ? "critical" : "warning";
    return {
      severity,
      title: label,
      detail:
        `Fields disagree with "${verdict.paper.title}" (${verdict.paper.year ?? "no year"}):\n` +
        verdict.issues.map((i) => `  - ${i.field}: ${i.detail}`).join("\n"),
    };
  }
  return {
    severity: "info",
    title: label,
    detail:
      verdict.reason === "wrong_candidate"
        ? `Only a partial title match was found ("${verdict.paper?.title}"), and its details do not line up - the lookup probably returned a different paper. Verify by hand.`
        : verdict.reason === "api_unavailable"
          ? "Could not be checked: the lookup service was unavailable."
          : verdict.reason === "no_candidates_untrusted" || verdict.reason === "no_match_untrusted"
            ? "No matching record found, but the free indexes miss books, classics, and tech reports; " +
              "without a Semantic Scholar key this is not conclusive - verify by hand."
            : "Only a borderline title match was found; worth an eyeball.",
  };
}
