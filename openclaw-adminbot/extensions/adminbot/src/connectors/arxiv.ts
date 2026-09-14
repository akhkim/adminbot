// Asks arXiv whether a paper is really there, and what it is called.
//
// Plain HTTP against the public export API, for the same reasons `openreview-notes.ts` gives: one
// query, nothing an SDK would add, and no credential to hold. The API answers Atom XML rather than
// JSON, and the two fields this needs -- whether there is an entry, and its title -- are read with
// a regex rather than a parser, because pulling in an XML dependency to read two tags out of a
// document arXiv has served the same way for twenty years is the wrong trade.
//
// Never throws. A probe is a question the lab asks about its own records, and "I could not tell"
// has to be an answer rather than a stack trace -- see contracts/paper-artifact-links.ts for why
// that distinction is the whole design.
import {
  isAdminBotArxivId,
  type AdminBotArtifactProbe,
  type AdminBotArtifactProbeResult,
} from "../contracts/paper-artifact-links.js";

const BASE_URL = "https://export.arxiv.org/api/query";
const TIMEOUT_MS = 20_000;

export type AdminBotArxivProbeOptions = {
  fetchImpl?: typeof globalThis.fetch;
  baseUrl?: string;
};

export function createArxivProbe(options: AdminBotArxivProbeOptions = {}): AdminBotArtifactProbe {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;
  return async (id) => {
    // The id arrives from `adminBotArxivId`, which matches arXiv's own two shapes -- checked again
    // against the same rule here, because this is the last point before it becomes a query
    // parameter and "the caller already checked" is not a property this function can verify.
    if (!isAdminBotArxivId(id)) {
      return { status: "unreadable", reason: "not an arXiv id" };
    }
    let body: string;
    try {
      const response = await fetchImpl(
        `${baseUrl}?id_list=${encodeURIComponent(id)}&max_results=1`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!response.ok) {
        return { status: "unreadable", reason: `arXiv answered ${response.status}` };
      }
      body = await response.text();
    } catch (error) {
      return { status: "unreadable", reason: (error as Error).message.slice(0, 200) };
    }
    return readArxivEntry(body);
  };
}

/**
 * Reads arXiv's Atom answer.
 *
 * A withdrawn or non-existent id does not 404: the feed comes back with one entry whose title is
 * literally "Error" and whose summary says the id is malformed or missing, which is the one case
 * worth calling `missing` -- arXiv is saying there is no such paper.
 */
export function readArxivEntry(body: string): AdminBotArtifactProbeResult {
  const entry = /<entry>([\S\s]*?)<\/entry>/u.exec(body)?.[1];
  if (!entry) {
    // A well-formed feed with no entries at all. arXiv does not normally answer this way, so it is
    // "we could not tell" rather than proof of absence.
    return { status: "unreadable", reason: "arXiv returned no entry" };
  }
  const title = /<title>([\S\s]*?)<\/title>/u.exec(entry)?.[1]?.replaceAll(/\s+/gu, " ").trim();
  if (!title || title.toLowerCase() === "error") {
    return { status: "missing" };
  }
  return { status: "found", title };
}
