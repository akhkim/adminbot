// What a request's status is called on screen, named once for both surfaces that draw it.
//
// The member's list and detail card (logistics-requests.ts) and the admin's queue
// (logistics-requests.queue.ts) each used to carry their own copy of this map, which is how the
// queue's dropdown and the detail card's pill could disagree about the same five values.
//
// The wording depends on the kind, not only on the status. For two of the three kinds the request
// and the thing being asked for are the same object -- a signature request *is* the document, a
// meeting request *is* the meeting -- so "Submitted" describes both. A letter request is not the
// letter: it is the ask for one. So the moment a member sent it, the row read "Submitted", which
// every reader took to mean the letter had reached the school, and the state a recommender actually
// wants named -- the letter has gone -- was called "Done".
//
// Letter wording is therefore written from the recommender's side, because they are who works this
// queue: `submitted` is a letter still to send, `completed` is one that has been sent. The stored
// status is untouched; the service's lifecycle is identical for all three kinds, and
// `adminBotLogisticsSettledStatuses` still decides what counts as finished.
import { t } from "../../../i18n/index.ts";
import type { LogisticsRequest, LogisticsRequestStatus } from "../auth/session.ts";

const STATUS_LABEL_KEY: Record<LogisticsRequestStatus, string> = {
  submitted: "logistics.requests.status.submitted",
  in_progress: "logistics.requests.status.inProgress",
  completed: "logistics.requests.status.completed",
  declined: "logistics.requests.status.declined",
  withdrawn: "logistics.requests.status.withdrawn",
};

const REC_LETTER_STATUS_LABEL_KEY: Record<LogisticsRequestStatus, string> = {
  submitted: "logistics.requests.recLetterStatus.submitted",
  in_progress: "logistics.requests.recLetterStatus.inProgress",
  completed: "logistics.requests.recLetterStatus.completed",
  declined: "logistics.requests.recLetterStatus.declined",
  withdrawn: "logistics.requests.recLetterStatus.withdrawn",
};

/** The status as this kind of request says it. Resolved through i18n, so callers pass it straight. */
export function logisticsStatusLabel(
  kind: LogisticsRequest["kind"],
  status: LogisticsRequestStatus,
): string {
  return t(
    kind === "recommendation_letters"
      ? REC_LETTER_STATUS_LABEL_KEY[status]
      : STATUS_LABEL_KEY[status],
  );
}
