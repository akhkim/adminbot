// Where a paper's PDF can be found when nobody uploaded one.
//
// The LinkedIn draft reads the compiled paper to get the title, the ordered author list and the
// abstract, and it used to insist the author upload that PDF by hand. They had already given it to
// the lab: `drive_pdf_arxiv` is the Drive copy of the exact PDF they intend to post, and filling it
// in is a step the card chases them for. Asking again for a file AdminBot already knows the
// location of is asking somebody to fetch their own homework.
//
// Pure. This decides *where* the PDF is; the host does the downloading, because that needs a
// Google session and this file must stay testable without one.
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";

/**
 * The Drive file id inside a share URL.
 *
 * Drive spells the same file three ways -- /file/d/<id>/view, ?id=<id>, and /open?id=<id> -- and a
 * paper card has collected all three over the years. Returns undefined rather than a guess for
 * anything else, including a folder link: downloading a folder as a PDF fails in a way that reads
 * as the draft being broken rather than as the wrong link being on file.
 */
export function driveFileIdFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  const path = /\/file\/d\/([a-zA-Z0-9_-]{10,})/u.exec(trimmed);
  if (path?.[1]) {
    return path[1];
  }
  const query = /[?&]id=([a-zA-Z0-9_-]{10,})/u.exec(trimmed);
  if (query?.[1]) {
    return query[1];
  }
  // A /document/d/ or /drive/folders/ link names something that is not a file to download.
  return undefined;
}

export type PaperPdfSource =
  | { kind: "drive"; fileId: string; url: string }
  | { kind: "none"; reason: string };

/**
 * Where to get this paper's PDF from, given what the card has on file.
 *
 * Only the Drive copy today. Overleaf is deliberately not attempted: there is no supported way to
 * ask it for a compiled PDF without driving a browser session as the author, and a draft that
 * silently produced last month's build would be worse than one that says it needs the Drive copy.
 * The message names that, so the answer is a step the author can actually take.
 */
export function resolvePaperPdfSource(slots: readonly AdminBotPaperSlotRecord[]): PaperPdfSource {
  const drive = slots.find((slot) => slot.slot === "drive_pdf_arxiv");
  const url = drive?.url?.trim() ?? "";
  if (!url) {
    return {
      kind: "none",
      reason:
        "No PDF on this paper yet. Fill in the Drive copy of the paper PDF on the card, or attach one here.",
    };
  }
  const fileId = driveFileIdFromUrl(url);
  if (!fileId) {
    return {
      kind: "none",
      reason:
        "The Drive link on this paper does not point at a file (a folder or a Doc cannot be read as the paper PDF). Attach the PDF here, or correct the link on the card.",
    };
  }
  return { kind: "drive", fileId, url };
}
