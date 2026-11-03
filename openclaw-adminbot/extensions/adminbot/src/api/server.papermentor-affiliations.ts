// The roster read PaperMentor makes while reviewing a paper: for each author on the title page,
// the affiliation the lab has on record for them and whether they hold Vector compute.
//
// Outside the authenticated route table on purpose. PaperMentor runs on another host and should
// not hold a credential that can do anything else, so it gets its own token,
// ADMINBOT_PAPERMENTOR_TOKEN, which opens this one read and nothing more. Unset, the route answers
// 404 as if it did not exist. The answer carries names and affiliation strings only -- never an
// email, id, note or status -- and only for authors who are already on the roster.
import type { IncomingMessage, ServerResponse } from "node:http";
import { adminBotComputeAccessRegistry, isAdminBotComputeAccess } from "../contracts/compute-access.js";
import type { AdminBotLabMember } from "../contracts/actions.js";
import { isSamePerson } from "../contracts/person-names.js";
import { bearerToken, constantTimeEqual } from "./routes/session.js";
import { PayloadTooLargeError, readJson, readRecord, sendJson } from "./server.http.js";

export const PAPERMENTOR_AFFILIATIONS_PATH = "/papermentor/author-affiliations";

const MAX_BODY_BYTES = 32 * 1024;
// A title page with more authors than this is not a paper the lab wrote.
const MAX_AUTHORS = 100;
const MAX_AUTHOR_LENGTH = 200;

export type PaperMentorAuthorAffiliation = {
  /** The author as the paper spells it, echoed back so the caller can line answers up. */
  author: string;
  /** Null when nobody on the roster is this author. */
  member: {
    name: string;
    /** The affiliation on the member's record, verbatim. Absent when none is recorded. */
    affiliation?: string;
    /** Holds Vector compute, or is counted by Vector as one of its people. */
    vector: boolean;
  } | null;
};

/** Whether the member holds any Vector cluster access or has a Vector role on record. */
function hasVector(member: AdminBotLabMember): boolean {
  if (member.vector_role) {
    return true;
  }
  return (member.compute_access ?? []).some(
    (value) =>
      isAdminBotComputeAccess(value) && adminBotComputeAccessRegistry[value].provider === "vector",
  );
}

/**
 * Match each author to the roster. A name that matches two members is answered as unmatched:
 * guessing whose affiliation to print on a paper is worse than printing none.
 */
export function paperMentorAuthorAffiliations(
  authors: readonly string[],
  members: readonly AdminBotLabMember[],
): PaperMentorAuthorAffiliation[] {
  return authors.map((author) => {
    const matches = members.filter(
      (member) =>
        isSamePerson(author, member.name) ||
        (member.preferred_name ? isSamePerson(author, member.preferred_name) : false),
    );
    if (matches.length !== 1) {
      return { author, member: null };
    }
    const [member] = matches;
    const affiliation = member.affiliation?.trim();
    return {
      author,
      member: {
        name: member.name,
        ...(affiliation ? { affiliation } : {}),
        vector: hasVector(member),
      },
    };
  });
}

export async function handlePaperMentorAffiliations(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  members: () => readonly AdminBotLabMember[],
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (!token) {
    sendJson(res, 404, { error: { message: "not found" } });
    return;
  }
  const bearer = bearerToken(req);
  if (!bearer || !constantTimeEqual(bearer, token)) {
    sendJson(res, 401, { error: { message: "authentication required" } });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: { message: "method not allowed" } });
    return;
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = readRecord(await readJson(req, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: { message: error.message } });
      return;
    }
    body = undefined;
  }
  const authors = body?.authors;
  if (
    !Array.isArray(authors) ||
    authors.length > MAX_AUTHORS ||
    !authors.every(
      (author) =>
        typeof author === "string" && author.trim() && author.length <= MAX_AUTHOR_LENGTH,
    )
  ) {
    sendJson(res, 400, {
      error: {
        message: `authors must be a list of at most ${MAX_AUTHORS} non-empty names`,
      },
    });
    return;
  }
  sendJson(res, 200, {
    authors: paperMentorAuthorAffiliations(authors as string[], members()),
  });
}
