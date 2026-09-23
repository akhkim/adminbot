import type { OpenReviewIdentityReview } from "../contracts/paper-artifact-links.js";

function value(field: unknown): unknown {
  return field && typeof field === "object" && "value" in field ? field.value : field;
}

function submission(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const note = raw as Record<string, unknown>;
  if (
    typeof note.id !== "string" ||
    !/^[A-Za-z0-9_-]{4,64}$/u.test(note.id) ||
    note.replyto ||
    note.forum !== note.id
  ) {
    return undefined;
  }
  const content = (note.content ?? {}) as Record<string, unknown>;
  const title = value(content.title);
  const abstract = value(content.abstract);
  const authors = value(content.authorids);
  const created = note.cdate ?? note.tcdate;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    typeof abstract !== "string" ||
    typeof created !== "number" ||
    !Number.isFinite(created) ||
    created <= 0 ||
    created > 8.64e15 ||
    !Array.isArray(authors)
  ) {
    return undefined;
  }
  return {
    id: note.id,
    title: title.trim().slice(0, 2000),
    abstract: abstract.slice(0, 20000),
    created,
    authors: [
      ...new Set(
        authors.filter(
          (id): id is string => typeof id === "string" && /^~[\p{L}\p{N}_.-]{1,150}$/u.test(id),
        ),
      ),
    ],
  };
}

function phrases(abstract: string): Set<string> {
  const words =
    abstract
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 40) {
    return new Set();
  }
  return new Set(
    words.slice(2).map((word, index) => `${words[index]} ${words[index + 1]} ${word}`),
  );
}

/** Public, bounded discovery. No author inference from blind submissions or credentials. */
export async function reviewOpenReviewIdentity(
  raw: unknown,
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<OpenReviewIdentityReview> {
  const source = submission(raw);
  const result: OpenReviewIdentityReview = {
    status: "insufficient",
    examined: 0,
    abstract_excerpt: source?.abstract.slice(0, 600) ?? "",
    candidates: [],
  };
  const sourcePhrases = phrases(source?.abstract ?? "");
  if (!source || !source.authors.length || sourcePhrases.size < 30) {
    return result;
  }

  // ponytail: first three public author IDs, 100 notes each; paginate only if this bounded
  // search misses useful matches in practice. Always expose truncated coverage to the reader.
  let incomplete = source.authors.length > 3;
  let successful = 0;
  const seen = new Set<string>();
  for (const author of source.authors.slice(0, 3)) {
    try {
      const query = new URLSearchParams({ "content.authorids": author, limit: "100" });
      const response = await fetchImpl(`${baseUrl}/notes?${query}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        incomplete = true;
        continue;
      }
      const body = (await response.json()) as { notes?: unknown; count?: number };
      if (!Array.isArray(body.notes)) {
        incomplete = true;
        continue;
      }
      successful++;
      incomplete ||= body.notes.length >= 100 || (body.count ?? 0) > body.notes.length;
      for (const rawCandidate of body.notes.slice(0, 100)) {
        const candidate = submission(rawCandidate);
        if (
          !candidate ||
          candidate.id === source.id ||
          seen.has(candidate.id) ||
          candidate.created >= source.created
        ) {
          continue;
        }
        seen.add(candidate.id);
        const shared = candidate.authors.filter((id) => source.authors.includes(id));
        const candidatePhrases = phrases(candidate.abstract);
        if (!shared.length || candidatePhrases.size < 30) {
          continue;
        }
        result.examined++;
        const common = [...sourcePhrases].filter((phrase) => candidatePhrases.has(phrase)).length;
        const overlap = (2 * common) / (sourcePhrases.size + candidatePhrases.size);
        // Conservative lexical evidence, not a probability that two papers are identical.
        if (overlap < 0.65) {
          continue;
        }
        result.candidates.push({
          id: candidate.id,
          title: candidate.title,
          abstract_excerpt: candidate.abstract.slice(0, 600),
          shared_authors: shared.slice(0, 10),
          abstract_overlap: Math.round(overlap * 100),
          created_at: new Date(candidate.created).toISOString(),
        });
      }
    } catch {
      incomplete = true;
    }
  }
  result.status = successful === 0 ? "unavailable" : incomplete ? "limited" : "checked";
  result.candidates.sort(
    (a, b) => b.abstract_overlap - a.abstract_overlap || a.id.localeCompare(b.id),
  );
  result.candidates = result.candidates.slice(0, 3);
  return result;
}
