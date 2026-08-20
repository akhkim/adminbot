// Closing out a signature request: what comes back, what goes in the email, and what stops being
// stored once it has.
//
// Kept apart from requests.ts because it is a different question. That file is about what a member
// may send in; this one is about what the lab sends back and what the database keeps afterwards.
// Both are pure -- the mail leaves through a typed action, and the store write is the service's.
import type {
  AdminBotLogisticsAttachment,
  AdminBotLogisticsRequest,
} from "../../contracts/actions.js";
import { adminBotLogisticsSettledStatuses } from "../../contracts/actions.js";
import { MAX_ATTACHMENT_BYTES, MAX_REQUEST_BYTES, base64ByteLength } from "./requests.js";

/** Why these signed documents cannot be filed, or null when they can. */
export function validateSignedDocuments(
  signed: readonly AdminBotLogisticsAttachment[],
): string | null {
  if (!signed.length) {
    return "a signed document is required";
  }
  let total = 0;
  for (const file of signed) {
    if (!file.name.trim()) {
      return "every signed document needs a file name";
    }
    const size = file.data_base64 ? base64ByteLength(file.data_base64) : -1;
    if (size < 0) {
      return `${file.name} is not readable as base64`;
    }
    if (size === 0) {
      return `${file.name} is empty`;
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      return `${file.name} is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`;
    }
    total += size;
  }
  if (total > MAX_REQUEST_BYTES) {
    return `the signed documents total more than ${Math.floor(MAX_REQUEST_BYTES / (1024 * 1024))}MB`;
  }
  return null;
}

/** The bytes this request is currently costing, which is what clearing it frees. */
export function storedRequestBytes(request: AdminBotLogisticsRequest): number {
  return [
    ...(request.documents ?? []),
    ...(request.attachments ?? []),
    ...(request.signed_documents ?? []),
  ].reduce((total, file) => total + (file.data_base64 ? base64ByteLength(file.data_base64) : 0), 0);
}

function isSettled(status: AdminBotLogisticsRequest["status"]): boolean {
  return (adminBotLogisticsSettledStatuses as readonly string[]).includes(status);
}

function stripBytes(
  files: AdminBotLogisticsAttachment[] | undefined,
): AdminBotLogisticsAttachment[] | undefined {
  return files?.map((file) => {
    const { data_base64: _bytes, ...rest } = file;
    return rest;
  });
}

/**
 * The same request with its file bytes dropped, once nobody is waiting on it.
 *
 * Names and sizes stay. A settled request still has to read as a complete history -- which document
 * was signed, how big it was, when it went back -- and that costs a few hundred bytes a row rather
 * than a few million. `files_cleared_at` is what lets a reader tell "this request never had a
 * document" from "its document has been cleared", which are different answers to the same empty
 * download button.
 *
 * A request that is not settled is returned untouched: the documents are the work.
 */
export function clearSettledRequestFiles(
  request: AdminBotLogisticsRequest,
): AdminBotLogisticsRequest {
  if (!isSettled(request.status) || request.files_cleared_at) {
    return request;
  }
  if (storedRequestBytes(request) === 0) {
    // Nothing to drop, so nothing to stamp: a request that arrived with no bytes was never holding
    // anything, and saying its files were cleared would be a small lie in the record.
    return request;
  }
  const documents = stripBytes(request.documents);
  const attachments = stripBytes(request.attachments);
  const signedDocuments = stripBytes(request.signed_documents);
  return {
    ...request,
    ...(documents ? { documents } : {}),
    ...(attachments ? { attachments } : {}),
    ...(signedDocuments ? { signed_documents: signedDocuments } : {}),
    files_cleared_at: new Date().toISOString(),
  };
}

export function signedDocumentEmailSubject(request: AdminBotLogisticsRequest): string {
  const context = request.description?.trim();
  // The member's own words for what they sent, so the subject line matches what they remember
  // asking for rather than an id only the service knows.
  return context ? `Signed: ${truncate(context, 60)}` : "Your signed documents";
}

/**
 * The note that travels with the signed file.
 *
 * Plain and short on purpose: the attachment is the message, and a member opening this wants to
 * know it is theirs, that it is signed, and whether anything was said about it.
 */
export function signedDocumentEmailBody(
  request: AdminBotLogisticsRequest,
  signed: readonly AdminBotLogisticsAttachment[],
  note?: string,
): string {
  const names = signed.map((file) => file.name).join(", ");
  const lines = [
    `Hi ${firstName(request.member_name)},`,
    "",
    signed.length === 1
      ? `Your document has been signed and is attached (${names}).`
      : `Your documents have been signed and are attached (${names}).`,
  ];
  if (request.description?.trim()) {
    lines.push("", `You asked for: ${request.description.trim()}`);
  }
  if (note?.trim()) {
    lines.push("", note.trim());
  }
  lines.push("", "AdminBot");
  return lines.join("\n");
}

function firstName(name: string): string {
  return name.trim().split(/\s+/u)[0] || name.trim() || "there";
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
