// Saved logistics requests, as an admin reads them.
//
// This module is the seam between "what the admin list shows" and where requests actually live.
// Today they live nowhere but the member's own browser: logistics-draft.ts writes a request to
// IndexedDB on the device it was typed on, and Submit is still inert, so nothing is ever sent. The
// only requests readable from here are therefore the ones saved in THIS browser -- an admin sees
// their own saved requests, not the lab's. The view says so on screen rather than presenting one
// device's drafts as the roster's.
//
// When the request path lands (propose -> approve -> execute against a route that stores the
// request), replace loadLocalLogisticsRequests with that read. Nothing else has to change: the
// view takes LogisticsRequest[] and knows nothing about where the list came from.
import {
  loadLogisticsDraft,
  loadRecommendationLettersDraft,
  type RecommendationSchool,
} from "./logistics-draft.ts";

export type LogisticsRequestType = "documentSignature" | "recommendationLetters";

/** Enough of a file to list it. The bytes stay in the draft store; the list only names them. */
export type LogisticsRequestFile = { name: string; size: number };

type LogisticsRequestBase = {
  // Stable across reloads -- it is the draft key the request was read from -- so an open request
  // survives a refresh and two requests of the same type can never collide.
  id: string;
  member: string;
  savedAt: number;
  // yyyy-mm-dd: the soonest date this request is working towards, or null when it names none.
  deadline: string | null;
};

export type LogisticsRequest = LogisticsRequestBase &
  (
    | {
        type: "documentSignature";
        documents: LogisticsRequestFile[];
        description: string;
        attachments: LogisticsRequestFile[];
      }
    | {
        type: "recommendationLetters";
        schools: RecommendationSchool[];
        cvOverleafUrl: string;
        driveFolderUrl: string;
      }
  );

export type LogisticsRequestsHost = {
  adminBotLogisticsRequests: LogisticsRequest[];
  adminBotLogisticsRequestsLoading: boolean;
};

// A date input hands back yyyy-mm-dd, but the value is stored as free text and read back from a
// record an older build may have written, so the shape is checked rather than trusted.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The soonest of the dates a request names -- what makes one request more urgent than another.
 *
 * ISO dates compare correctly as strings, so this is a plain minimum over the well-formed ones.
 */
export function soonestDeadline(dates: readonly string[]): string | null {
  const usable = dates.filter((date) => ISO_DATE.test(date));
  return usable.length ? usable.reduce((soonest, date) => (date < soonest ? date : soonest)) : null;
}

/** Both deadlines from every school: a letter is late if either of its dates passes. */
export function schoolDeadlines(schools: readonly RecommendationSchool[]): string[] {
  return schools.flatMap((school) => [school.applicationDeadline, school.letterDeadline]);
}

/**
 * Most urgent first. A request that names no deadline sorts last rather than first -- there is
 * nothing to be late for -- and ties break on the most recently saved.
 */
export function compareRequests(left: LogisticsRequest, right: LogisticsRequest): number {
  if (left.deadline !== right.deadline) {
    if (!left.deadline) {
      return 1;
    }
    if (!right.deadline) {
      return -1;
    }
    return left.deadline < right.deadline ? -1 : 1;
  }
  return right.savedAt - left.savedAt;
}

function describeFile(file: File): LogisticsRequestFile {
  return { name: file.name, size: file.size };
}

/**
 * Every request saved in this browser, as the list wants them.
 *
 * Reads fail silently to an empty list for the same reason the drafts restore silently: a browser
 * that blocks IndexedDB should show "nothing saved", not an error about storage.
 */
export async function loadLocalLogisticsRequests(member: string): Promise<LogisticsRequest[]> {
  const [signature, letters] = await Promise.all([
    loadLogisticsDraft().catch(() => null),
    loadRecommendationLettersDraft().catch(() => null),
  ]);
  const requests: LogisticsRequest[] = [];
  if (signature) {
    requests.push({
      id: "document-signature",
      member,
      savedAt: signature.savedAt,
      // A signature request names no date of its own: the deadline lives in the description, in
      // whatever words the member used, and guessing a date out of prose would be worse than none.
      deadline: null,
      type: "documentSignature",
      documents: signature.signatureFiles.map(describeFile),
      description: signature.description,
      attachments: signature.attachments.map(describeFile),
    });
  }
  if (letters) {
    requests.push({
      id: "recommendation-letters",
      member,
      savedAt: letters.savedAt,
      deadline: soonestDeadline(schoolDeadlines(letters.schools)),
      type: "recommendationLetters",
      schools: letters.schools,
      cvOverleafUrl: letters.cvOverleafUrl,
      driveFolderUrl: letters.driveFolderUrl,
    });
  }
  return requests.toSorted(compareRequests);
}

/** Fills the list for the admin view. Host state carries the in-flight flag so the view can say so. */
export async function loadAdminBotLogisticsRequests(
  host: LogisticsRequestsHost,
  member: string,
): Promise<void> {
  host.adminBotLogisticsRequestsLoading = true;
  try {
    host.adminBotLogisticsRequests = await loadLocalLogisticsRequests(member);
  } finally {
    host.adminBotLogisticsRequestsLoading = false;
  }
}
