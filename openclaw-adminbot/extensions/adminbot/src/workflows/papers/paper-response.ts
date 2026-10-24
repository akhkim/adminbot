// The one shape a paper record leaves the service in.
//
// Every route that hands a paper to a client goes through `paperForResponse`, so what a reader can
// see is decided in one place rather than at each of the reads that happen to return a paper.
import type { AdminBotPaperArtifactLinks, AdminBotPaperRecord } from "../../contracts/actions.js";

/**
 * Artifact keys that are never returned and never accepted on a paper write.
 *
 * `arxiv_paper_password` is a credential. It belongs to the `arxiv_paper_password` evidence slot,
 * whose read is redacted for anyone who is not an author or an admin; as an artifact it went to
 * every member who listed papers. Records written before the slot existed may still hold it, so
 * it is stripped on the way out rather than trusted to be absent.
 */
export const ADMINBOT_PAPER_WITHHELD_ARTIFACTS = ["arxiv_paper_password"] as const;

/** Which withheld key a write tried to set, if any. */
export function withheldArtifactIn(artifacts: unknown): string | undefined {
  if (!artifacts || typeof artifacts !== "object") {
    return undefined;
  }
  return ADMINBOT_PAPER_WITHHELD_ARTIFACTS.find((key) => Object.hasOwn(artifacts, key));
}

/**
 * Why a paper write must be refused, or undefined when it may go ahead.
 *
 * Refused when the write sets a withheld key to anything other than what is already stored. An
 * internal caller that re-sends a record it read from the store carries a legacy value through
 * unchanged, and that is not a write of it; anything else is somebody putting a credential where
 * every member can list it.
 */
export function withheldArtifactWriteError(
  incoming: unknown,
  existing: AdminBotPaperArtifactLinks | undefined,
): string | undefined {
  const key = withheldArtifactIn(incoming);
  if (!key) {
    return undefined;
  }
  const sent = (incoming as Record<string, unknown>)[key];
  const stored = (existing as Record<string, unknown> | undefined)?.[key];
  return sent === stored
    ? undefined
    : `${key} is not a paper artifact; set it with PUT /papers/:id/slots/${key}`;
}

/**
 * The incoming record without `timeline`.
 *
 * Clients that still hold a paper read before the timeline was dropped send it back on save; it is
 * not stored, so it cannot come back out frozen at the step it was saved on.
 */
export function withoutTimeline<T extends object>(paper: T): Omit<T, "timeline"> {
  const { timeline: _timeline, ...rest } = paper as T & { timeline?: unknown };
  return rest;
}

/** The artifacts with every withheld key removed. */
export function withoutWithheldArtifacts<T extends AdminBotPaperArtifactLinks | undefined>(
  artifacts: T,
): T {
  if (!artifacts || !withheldArtifactIn(artifacts)) {
    return artifacts;
  }
  const kept: Record<string, unknown> = { ...artifacts };
  for (const key of ADMINBOT_PAPER_WITHHELD_ARTIFACTS) {
    delete kept[key];
  }
  return kept as T;
}

/**
 * A paper as a client may receive it.
 *
 * Also drops `timeline`: it is no longer computed, and a record a client once wrote back with the
 * old computed timeline in it would otherwise keep returning that copy, frozen at the step it was
 * saved on.
 */
export function paperForResponse(paper: AdminBotPaperRecord): AdminBotPaperRecord {
  const rest = withoutTimeline(paper);
  return rest.artifacts ? { ...rest, artifacts: withoutWithheldArtifacts(rest.artifacts) } : rest;
}
