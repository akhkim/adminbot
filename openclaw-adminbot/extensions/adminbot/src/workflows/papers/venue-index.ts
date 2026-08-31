// Building and searching a conference's paper index.
//
// The two halves have very different costs and audiences, which is why they are separate calls
// rather than one lazy "search, indexing if needed". Building fetches a few thousand papers and
// embeds every one of them -- ~85 seconds for a 4,000-paper venue against the local model -- and
// is an admin pressing a button. Searching embeds one short string and runs a dot product per
// paper, which is milliseconds, and is a member typing.
//
// Collapsing them would mean the first member to open the tab after a new conference is added
// waits a minute and a half for a page that usually returns instantly, with no way to tell
// whether it is working.

import type { Embedder } from "../../connectors/embeddings.js";
import type { OpenReviewNotesReader, OpenReviewPaper } from "../../connectors/openreview-notes.js";
import type { AdminBotVenuePaper, AdminBotVenueSource } from "../../contracts/actions.js";
import {
  interestsEmbeddingText,
  paperEmbeddingText,
  rankPapers,
  type RankOptions,
  type VenueRanking,
} from "./venue-relevance.js";

export type VenueIndexResult = {
  venue_id: string;
  label: string;
  paper_count: number;
  indexed_at: string;
  embedding_model: string;
};

export type VenueIndexDeps = {
  readVenue: OpenReviewNotesReader;
  embed: Embedder;
  embeddingModel: string;
  now: () => Date;
};

/**
 * Fetches a venue's accepted papers, embeds them, and hands back rows ready to store.
 *
 * Returns rather than writes, so the caller owns the transaction and a failure here never touches
 * the index that is already there. A venue that answers with nothing is *not* an error -- a
 * conference that has not released decisions yet is a normal state, and the count says so.
 */
export async function buildVenueIndex(
  source: AdminBotVenueSource,
  deps: VenueIndexDeps,
): Promise<{ papers: AdminBotVenuePaper[]; result: VenueIndexResult }> {
  return embedFetchedPapers(source, await deps.readVenue(source.id), deps);
}

/**
 * Rebuild a venue only when its accepted-paper list has actually moved.
 *
 * This is what makes the index track a conference's decisions rather than a calendar. Results do
 * not land on a date anyone can put in a cron expression -- a NeurIPS or ICLR notification slips,
 * and ARR runs on cycles rather than one release a year -- so the schedule cannot know when to
 * rebuild. The venue itself does: a conference that has not decided yet answers with nothing (see
 * buildVenueIndex), and the moment decisions are published the same call answers with thousands of
 * papers.
 *
 * The asymmetry between the two halves of an index is what makes watching for that affordable.
 * Fetching a venue is one API call; embedding it is ~85 seconds of the local model. So this always
 * fetches, and embeds only when the count it got back disagrees with the count already stored --
 * which covers the case this exists for (nothing -> decisions out), a venue that has never been
 * indexed, and the later drift of camera-ready additions and withdrawals.
 *
 * `storedCount` is undefined for a venue with no index at all, which always rebuilds. Passing the
 * count rather than the rows keeps the caller from loading a few thousand vectors to answer a
 * question about their number.
 *
 * The one change it cannot see is a same-size swap -- one paper withdrawn and another added
 * between two runs. That is rare, self-corrects on the next real change, and the Tasks & Tools
 * button still forces a full rebuild for anyone who wants one now.
 */
export async function refreshVenueIndexIfChanged(
  source: AdminBotVenueSource,
  deps: VenueIndexDeps,
  storedCount: number | undefined,
): Promise<
  | { changed: false; venue_id: string; label: string; paper_count: number }
  | { changed: true; papers: AdminBotVenuePaper[]; result: VenueIndexResult }
> {
  const fetched = await deps.readVenue(source.id);
  if (storedCount !== undefined && fetched.length === storedCount) {
    return {
      changed: false,
      venue_id: source.id,
      label: source.label,
      paper_count: fetched.length,
    };
  }
  return { changed: true, ...(await embedFetchedPapers(source, fetched, deps)) };
}

async function embedFetchedPapers(
  source: AdminBotVenueSource,
  fetched: readonly OpenReviewPaper[],
  deps: VenueIndexDeps,
): Promise<{ papers: AdminBotVenuePaper[]; result: VenueIndexResult }> {
  const indexedAt = deps.now().toISOString();
  if (!fetched.length) {
    return {
      papers: [],
      result: {
        venue_id: source.id,
        label: source.label,
        paper_count: 0,
        indexed_at: indexedAt,
        embedding_model: deps.embeddingModel,
      },
    };
  }
  const vectors = await deps.embed(fetched.map(paperEmbeddingText));
  // The embedder already refuses a short batch, so this can only fire if that contract changes.
  // Kept because the failure it guards against -- every paper paired with another paper's vector
  // -- produces plausible-looking nonsense rather than an error.
  if (vectors.length !== fetched.length) {
    throw new Error(
      `embedded ${vectors.length} vectors for ${fetched.length} papers in ${source.id}`,
    );
  }
  return {
    papers: fetched.map((paper, index) => toVenuePaper(source.id, paper, vectors[index] ?? [])),
    result: {
      venue_id: source.id,
      label: source.label,
      paper_count: fetched.length,
      indexed_at: indexedAt,
      embedding_model: deps.embeddingModel,
    },
  };
}

function toVenuePaper(
  venueId: string,
  paper: OpenReviewPaper,
  vector: number[],
): AdminBotVenuePaper {
  return {
    venue_id: venueId,
    paper_id: paper.id,
    title: paper.title,
    abstract: paper.abstract,
    keywords: paper.keywords,
    venue: paper.venue,
    ...(paper.pdf_url ? { pdf_url: paper.pdf_url } : {}),
    forum_url: paper.forum_url,
    vector,
  };
}

/** The stored row back in the shape the ranker takes. */
export function toRankable(row: AdminBotVenuePaper): {
  paper: OpenReviewPaper;
  vector: readonly number[];
} {
  return {
    paper: {
      id: row.paper_id,
      title: row.title,
      abstract: row.abstract,
      keywords: row.keywords,
      venue: row.venue,
      ...(row.pdf_url ? { pdf_url: row.pdf_url } : {}),
      forum_url: row.forum_url,
    },
    vector: row.vector,
  };
}

/**
 * Ranks one indexed venue against a member's interests.
 *
 * The interests are embedded here, on every search, rather than cached against the member: they
 * are one short string, the member edits them freely on the page, and a cached vector that no
 * longer matches the box they are looking at would be the worst of both.
 */
export async function searchVenue(params: {
  rows: readonly AdminBotVenuePaper[];
  interests: string;
  embed: Embedder;
  options?: RankOptions;
}): Promise<VenueRanking> {
  const interests = params.interests.trim();
  if (!interests || !params.rows.length) {
    return { results: [], nothing_relevant: false };
  }
  const [vector] = await params.embed([interestsEmbeddingText(interests)]);
  if (!vector) {
    throw new Error("the embedding model returned no vector for the interests");
  }
  return rankPapers(params.rows.map(toRankable), vector, interests, params.options ?? {});
}
