/**
 * The `book_meeting` queue, checked and proposed onto Zhijing's WhatsApp call sheet.
 *
 * Three steps, in this order, and the order is the feature: gather the open call requests, ask
 * Google whether each one's doc prep document can actually be opened, and turn only the ones that
 * can into a `sheet.update_cells` proposal. A request whose link is a `TODO` or an unshared
 * document does not become a row -- it becomes a sentence telling its author what to fix, because
 * the alternative is Zhijing reaching a trip break, opening the queue and finding nothing to read.
 *
 * Preview and propose are the same computation with the last step removed, so what an admin
 * approves is exactly what they were shown. Nothing here writes to Google: the proposal is handed
 * to the approval gate like every other external effect.
 */
import type { AdminBotLogisticsMeeting, AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotService } from "../kernel/service.js";
import {
  type CallRequestEntry,
  type CallRequestSkip,
  planCallRequestAppend,
} from "../workflows/logistics/call-request-sheet.js";
import {
  checkDocPrepLink,
  type DocPrepLinkVerdict,
  type DocPrepProbe,
  explainDocPrepVerdict,
  fetchDocPrepProbe,
} from "../workflows/logistics/doc-prep-link.js";
import type { CallSheetSource } from "./call-sheet-config.js";

/**
 * Statuses whose requests still want a call.
 *
 * `completed`, `declined` and `withdrawn` are settled: pushing one would put a row in front of her
 * for a call that is already dealt with.
 */
const OPEN_STATUSES = new Set(["submitted", "in_progress"]);

/** One meeting row, with the verdict on its doc prep link and the sentence that explains it. */
export type CallSheetCandidate = {
  /** `<request id>#<row index>`: a request may carry several meeting rows, each its own ask. */
  entry_id: string;
  request_id: string;
  member_id: string;
  member_name: string;
  purpose: string;
  doc_prep_url: string;
  doc_prep: DocPrepLinkVerdict;
  /** What to tell the member, from `explainDocPrepVerdict`. */
  message: string;
};

export type CallSheetPush = {
  spreadsheet_id: string;
  tab: string;
  url: string;
  /** Every open meeting row and what its link turned out to be, pushable or not. */
  candidates: CallSheetCandidate[];
  placed: { request_id: string; member_name: string; sheet_row: number }[];
  skipped: CallRequestSkip[];
  /** Absent on a preview, and on a push that had nothing valid to write. */
  proposal?: AdminBotStoredProposal;
};

export type CallSheetError = { error: { status: number; message: string } };

/** What one automatic push did, in the words the member who submitted it should read. */
export type CallSheetQueued = {
  /** True once the row is in a filed proposal. Not yet on the sheet -- that needs the approval. */
  queued: boolean;
  message: string;
};

export type CallSheetOptions = {
  /** Injected in tests; defaults to an unauthenticated GET, which is the point of the check. */
  probe?: DocPrepProbe;
  /** Restricts the push to named requests, for an admin pushing one row rather than the queue. */
  request_ids?: readonly string[];
};

const RANGE = "A:ZZ";

function rangeFor(tab: string): string {
  return `${tab}!${RANGE}`;
}

async function resolveTarget(source: CallSheetSource): Promise<{ tab: string; url: string }> {
  const resolved = await source.resolveTab?.();
  const tab = resolved?.tab || source.tab;
  const base = `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit`;
  return {
    tab,
    url: resolved?.gid === undefined ? base : `${base}#gid=${resolved.gid}`,
  };
}

/**
 * One candidate plus the row it came from, kept together so the planner does not re-walk requests.
 *
 * Internal: the meeting is the stored shape and the candidate is the reportable one, and only the
 * candidate is meant to leave this file.
 */
type GatheredRow = {
  candidate: CallSheetCandidate;
  entry: CallRequestEntry;
};

/**
 * The open call requests, flattened to one candidate per meeting row and each link checked.
 *
 * Links are probed concurrently. They are independent network calls against the same host and a
 * queue of twenty checked in series would have the admin watching a spinner for the sum of twenty
 * timeouts rather than the longest one.
 */
async function gather(
  service: AdminBotService,
  options: CallSheetOptions,
): Promise<GatheredRow[] | CallSheetError> {
  const listed = service.listLogisticsRequests();
  if (!listed.ok) {
    return { error: { status: listed.status, message: listed.error.message } };
  }
  const wanted = options.request_ids?.length ? new Set(options.request_ids) : undefined;
  const probe = options.probe ?? fetchDocPrepProbe;

  const rows: {
    request: (typeof listed.payload.requests)[number];
    meeting: AdminBotLogisticsMeeting;
    index: number;
  }[] = [];
  for (const request of listed.payload.requests) {
    if (request.kind !== "book_meeting" || !OPEN_STATUSES.has(request.status)) {
      continue;
    }
    if (wanted && !wanted.has(request.id)) {
      continue;
    }
    (request.meetings ?? []).forEach((meeting, index) => {
      rows.push({ request, meeting, index });
    });
  }

  return Promise.all(
    rows.map(async ({ request, meeting, index }): Promise<GatheredRow> => {
      const verdict = await checkDocPrepLink(meeting.doc_prep_url, probe);
      return {
        candidate: {
          entry_id: `${request.id}#${index}`,
          request_id: request.id,
          member_id: request.member_id,
          member_name: request.member_name,
          purpose: meeting.purpose,
          doc_prep_url: meeting.doc_prep_url ?? "",
          doc_prep: verdict,
          message: explainDocPrepVerdict(verdict),
        },
        entry: {
          request_id: request.id,
          member_name: request.member_name,
          purpose: meeting.purpose,
          ...(meeting.city === undefined ? {} : { city: meeting.city }),
          ...(meeting.timezone === undefined ? {} : { timezone: meeting.timezone }),
          ...(meeting.length_minutes === undefined
            ? {}
            : { length_minutes: meeting.length_minutes }),
          ...(meeting.latest_ok_date === undefined
            ? {}
            : { latest_ok_date: meeting.latest_ok_date }),
          ...(meeting.whatsapp_hello === undefined
            ? {}
            : { whatsapp_hello: meeting.whatsapp_hello }),
          // A meeting row carries its own submission time when the member added it later; the
          // request's is the fallback, so the sheet's "time you entered" column is never blank.
          submitted_at: meeting.submitted_at ?? request.submitted_at,
          doc_prep: verdict,
        },
      };
    }),
  );
}

/** Everything both entry points do before they differ, which is all of it but the proposal. */
async function planPush(
  service: AdminBotService,
  source: CallSheetSource,
  options: CallSheetOptions,
): Promise<
  | {
      ok: true;
      base: CallSheetPush;
      plan: Exclude<ReturnType<typeof planCallRequestAppend>, { error: string }>;
    }
  | CallSheetError
> {
  const gathered = await gather(service, options);
  if ("error" in gathered) {
    return gathered;
  }
  const target = await resolveTarget(source);
  let values: string[][];
  try {
    values = await source.read(rangeFor(target.tab));
  } catch (error) {
    return {
      error: {
        status: 502,
        message: `could not read the call sheet: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const plan = planCallRequestAppend(
    target.tab,
    values,
    gathered.map((row) => row.entry),
  );
  if ("error" in plan) {
    return { error: { status: 502, message: plan.error } };
  }
  return {
    ok: true,
    base: {
      spreadsheet_id: source.spreadsheetId,
      tab: target.tab,
      url: target.url,
      candidates: gathered.map((row) => row.candidate),
      placed: plan.placed,
      skipped: plan.skipped,
    },
    plan,
  };
}

/** What the push would do, with nothing proposed. Safe to call on every tab render. */
export async function previewCallSheetPush(
  service: AdminBotService,
  source: CallSheetSource,
  options: CallSheetOptions = {},
): Promise<CallSheetPush | CallSheetError> {
  const planned = await planPush(service, source, options);
  return "error" in planned ? planned : planned.base;
}

/**
 * The same plan, with a proposal raised for whatever it would write.
 *
 * A plan that writes nothing raises no proposal and is not an error: "every open request is already
 * on the sheet" and "every open request has a broken link" are both answers an admin needs to see,
 * and an empty approval card would say neither.
 */
export async function proposeCallSheetPush(
  service: AdminBotService,
  source: CallSheetSource,
  actor: string,
  options: CallSheetOptions = {},
): Promise<CallSheetPush | CallSheetError> {
  const planned = await planPush(service, source, options);
  if ("error" in planned) {
    return planned;
  }
  const { base, plan } = planned;
  if (plan.updates.length === 0) {
    return base;
  }

  const rows = plan.placed.length === 1 ? "1 call request" : `${plan.placed.length} call requests`;
  const names = plan.placed.map((row) => row.member_name).join(", ");
  const created = service.createProposal({
    type: "sheet.update_cells",
    summary: `${actor}: add ${rows} to the WhatsApp call queue (${names})`,
    rationale:
      "Doc prep links were checked signed-out and open for anyone with the link; requests whose links did not are listed as skipped.",
    proposed_payload: {
      spreadsheet_id: source.spreadsheetId,
      updates: plan.updates,
      before: plan.before,
    },
  });
  if (!created.ok) {
    return {
      error: { status: created.status, message: created.error.message },
    };
  }
  return { ...base, proposal: created.payload };
}

/**
 * The push for a single request, run as its author submits it.
 *
 * The queue push an admin runs takes the whole open queue; this takes the one request that just
 * arrived, so the row is proposed while its author is still on the page and can be told what is
 * wrong with it. Everything else is the same computation -- the same link check, the same
 * duplicate rule, the same proposal -- because a row that reaches the sheet by this path must be
 * the row that would have reached it by the other one.
 *
 * It proposes. It does not write: `sheet.update_cells` is T2 (kernel/service.ts), and a member
 * submitting a form is not an approval. What is automatic here is the filing, not the write.
 *
 * Never throws and never fails the submission it is attached to. The request is already stored by
 * the time this runs, and a spreadsheet that cannot be read is not a reason to lose it -- the
 * queue push remains there to pick the row up later.
 */
export async function queueCallSheetRow(
  service: AdminBotService,
  source: CallSheetSource,
  actor: string,
  requestId: string,
  options: Omit<CallSheetOptions, "request_ids"> = {},
): Promise<CallSheetQueued> {
  let push: CallSheetPush | CallSheetError;
  try {
    push = await proposeCallSheetPush(service, source, actor, {
      ...options,
      request_ids: [requestId],
    });
  } catch (error) {
    return {
      queued: false,
      message: `The call queue could not be reached, so this is not on the sheet yet: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if ("error" in push) {
    return {
      queued: false,
      message: `The call queue could not be read, so this is not on the sheet yet: ${push.error.message}`,
    };
  }
  if (push.placed.some((row) => row.request_id === requestId)) {
    return {
      queued: true,
      message: "Added to Zhijing's call queue, pending an admin's approval.",
    };
  }
  // Not placed. The skip carries the sharper sentence (a duplicate, a full block); the candidate's
  // carries the doc-prep explanation. Either beats a generic failure, because both name the thing
  // the member can go and fix.
  const skipped = push.skipped.find((row) => row.request_id === requestId);
  if (skipped) {
    return { queued: false, message: skipped.detail };
  }
  const candidate = push.candidates.find((row) => row.request_id === requestId);
  return {
    queued: false,
    message:
      candidate?.message ??
      "This request is not on the call queue yet; an admin can push it from the queue.",
  };
}
