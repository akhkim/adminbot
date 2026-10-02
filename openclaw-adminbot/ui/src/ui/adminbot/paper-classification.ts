// Read legacy combined decisions without discarding the original stored answer.
import type { AdminBotPaperRecord } from "./controllers/admin.ts";

export const PUBLICATION_TRACKS = ["main", "findings"] as const;
export const PRESENTATION_FORMATS = ["poster", "spotlight", "oral", "award"] as const;
export function publicationTrack(paper: AdminBotPaperRecord): string {
  return (
    paper.artifacts?.publication_track ??
    (PUBLICATION_TRACKS.some((track) => track === paper.presentation_type)
      ? paper.presentation_type!
      : "")
  );
}
export function presentationFormat(paper: AdminBotPaperRecord): string {
  return PRESENTATION_FORMATS.some((format) => format === paper.presentation_type)
    ? paper.presentation_type!
    : "";
}
