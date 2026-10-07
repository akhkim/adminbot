// Reimbursement packets.
//
// Controller for this zone: loads through api/reimbursements.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import type { AdminBotReimbursementCheck } from "../../../../../extensions/adminbot/src/contracts/reimbursement-rules.js";
import { submitReimbursementPackage } from "../api/reimbursements.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotHost,
  type AdminBotReimbursementArtifact,
  type AdminBotReimbursementState,
  formatAdminBotToolError,
  invokeAdminBotTool,
  readRecord,
} from "./admin.ts";

// The guest flow runs before any gateway connection exists, so it needs only the reimbursement
// slice of the host plus the resolved AdminBot origin -- deliberately not the full AdminBotHost,
// which would imply a client/session this path does not have.
export type GuestReimbursementHost = {
  adminBotReimbursement: AdminBotReimbursementState;
  guestReimbursementBaseUrl: string;
};

type ReimbursementConversationResult = {
  assistant_message: string;
  draft: Record<string, unknown>;
  missing_fields: string[];
  ready: boolean;
  receipt_names: string[];
  /** The pre-submission report the service ran against the chosen funder's ruleset. */
  check?: AdminBotReimbursementCheck;
};

type ReimbursementGenerationResult = {
  artifacts: AdminBotReimbursementArtifact[];
  submission_proof?: string;
};

export async function sendAdminBotReimbursementMessage(
  host: AdminBotHost,
  message: string,
  files: File[],
): Promise<void> {
  const userMessage = message.trim();
  if (!userMessage || host.adminBotReimbursement.busy) {
    return;
  }
  host.adminBotReimbursement = {
    ...host.adminBotReimbursement,
    busy: true,
    error: null,
    artifacts: [],
  };
  const requestState = host.adminBotReimbursement;
  try {
    const receipts = await Promise.all(files.map(receiptPayload));
    if (host.adminBotReimbursement !== requestState) {
      return;
    }
    const result = (await invokeAdminBotTool(host, "adminbot_reimbursement_converse", {
      message: userMessage,
      messages: host.adminBotReimbursement.messages,
      draft: host.adminBotReimbursement.draft,
      ...(receipts.length ? { receipts } : {}),
    })) as ReimbursementConversationResult;
    if (host.adminBotReimbursement !== requestState) {
      return;
    }
    host.adminBotReimbursement = {
      messages: [
        ...host.adminBotReimbursement.messages,
        { role: "user", content: userMessage },
        { role: "assistant", content: result.assistant_message },
      ],
      draft: readRecord(result.draft),
      missingFields: Array.isArray(result.missing_fields) ? result.missing_fields : [],
      receiptNames: [
        ...new Set([
          ...host.adminBotReimbursement.receiptNames,
          ...(Array.isArray(result.receipt_names) ? result.receipt_names : []),
        ]),
      ],
      ready: result.ready === true,
      busy: false,
      error: null,
      artifacts: [],
      ...(host.adminBotReimbursement.funder ? { funder: host.adminBotReimbursement.funder } : {}),
      ...(result.check ? { check: result.check } : {}),
    };
  } catch (err) {
    if (host.adminBotReimbursement !== requestState) {
      return;
    }
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

export async function generateAdminBotReimbursement(host: AdminBotHost): Promise<void> {
  if (!host.adminBotReimbursement.ready || host.adminBotReimbursement.busy) {
    return;
  }
  host.adminBotReimbursement = { ...host.adminBotReimbursement, busy: true, error: null };
  const requestState = host.adminBotReimbursement;
  try {
    const result = (await invokeAdminBotTool(host, "adminbot_reimbursement_generate", {
      draft: host.adminBotReimbursement.draft,
    })) as ReimbursementGenerationResult;
    if (host.adminBotReimbursement !== requestState) {
      return;
    }
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
      submissionProof: result.submission_proof,
    };
  } catch (err) {
    if (host.adminBotReimbursement !== requestState) {
      return;
    }
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

/**
 * Mail the generated package to the funder's office.
 *
 * The member's own session, always: the service resolves both the recipient (from settings, by
 * funder) and the reply-to (from that member's record), so nothing about where this goes or who
 * answers it comes from the browser.
 */
export async function submitAdminBotReimbursement(host: AdminBotHost): Promise<void> {
  const state = host.adminBotReimbursement;
  if (!state.funder || !state.artifacts.length || state.busy) {
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotReimbursement = {
      ...state,
      error: "Sign in to have AdminBot send this for you.",
    };
    return;
  }
  host.adminBotReimbursement = { ...state, busy: true, error: null };
  const requestState = host.adminBotReimbursement;
  try {
    const result = await submitReimbursementPackage(
      {
        funder: state.funder,
        submission_proof: state.submissionProof,
        artifacts: state.artifacts.map((artifact) => ({
          filename: artifact.filename,
          data_base64: artifact.data_base64,
        })),
        ...(typeof state.draft.trip_title === "string"
          ? { trip_title: state.draft.trip_title }
          : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (
      host.adminBotReimbursement !== requestState ||
      loadStoredMemberSession()?.sessionToken !== stored.sessionToken
    ) {
      return;
    }
    if (!result.ok) {
      host.adminBotReimbursement = {
        ...host.adminBotReimbursement,
        busy: false,
        error:
          result.kind === "unreachable"
            ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
            : (result.message ??
              "Couldn't send the package. Check the office address in settings and try again."),
      };
      return;
    }
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      submission: { to: result.value.to, reply_to: result.value.reply_to },
    };
  } catch (err) {
    if (host.adminBotReimbursement !== requestState) {
      return;
    }
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

const RECEIPT_MEDIA_TYPES_BY_EXTENSION: Record<
  string,
  "application/pdf" | "image/png" | "image/jpeg"
> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function resolveReceiptMediaType(
  file: File,
): "application/pdf" | "image/png" | "image/jpeg" | undefined {
  if (file.type === "application/pdf" || file.type === "image/png" || file.type === "image/jpeg") {
    return file.type;
  }
  const name = file.name.toLowerCase();
  const extension = Object.keys(RECEIPT_MEDIA_TYPES_BY_EXTENSION).find((candidate) =>
    name.endsWith(candidate),
  );
  return extension ? RECEIPT_MEDIA_TYPES_BY_EXTENSION[extension] : undefined;
}

// Guest (not-signed-in) reimbursement path. The signed-in flow reaches the workflow through the
// gateway's `tools.invoke`, which needs a connected gateway client and therefore a login; these two
// helpers talk to the AdminBot service's own HTTP routes instead, which accept anonymous callers.
// Everything else about the flow -- state shape, receipt encoding, error text -- stays shared, so
// the guest view and the signed-in view cannot drift apart.
async function guestReimbursementRequest(
  baseUrl: string,
  path: "/reimbursements/converse" | "/reimbursements/generate",
  payload: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      // No credentials: the route is anonymous, and sending them would be misleading.
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the AdminBot service. Check that it is running.");
  }
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many reimbursement requests from this network. Try again later.");
    }
    throw new Error(body?.error?.message ?? `Reimbursement request failed (${response.status}).`);
  }
  return body;
}

export async function sendGuestReimbursementMessage(
  host: GuestReimbursementHost,
  message: string,
  files: File[],
): Promise<void> {
  const userMessage = message.trim();
  if (!userMessage || host.adminBotReimbursement.busy) {
    return;
  }
  host.adminBotReimbursement = {
    ...host.adminBotReimbursement,
    busy: true,
    error: null,
    artifacts: [],
  };
  try {
    const receipts = await Promise.all(files.map(receiptPayload));
    const result = (await guestReimbursementRequest(
      host.guestReimbursementBaseUrl,
      "/reimbursements/converse",
      {
        message: userMessage,
        messages: host.adminBotReimbursement.messages,
        draft: host.adminBotReimbursement.draft,
        // Sent on every turn, not just the first: the service re-runs the rule check each time and
        // there is no ruleset to apply without it.
        ...(host.adminBotReimbursement.funder ? { funder: host.adminBotReimbursement.funder } : {}),
        ...(receipts.length ? { receipts } : {}),
      },
    )) as ReimbursementConversationResult;
    host.adminBotReimbursement = {
      messages: [
        ...host.adminBotReimbursement.messages,
        { role: "user", content: userMessage },
        { role: "assistant", content: result.assistant_message },
      ],
      draft: readRecord(result.draft),
      missingFields: Array.isArray(result.missing_fields) ? result.missing_fields : [],
      receiptNames: [
        ...new Set([
          ...host.adminBotReimbursement.receiptNames,
          ...(Array.isArray(result.receipt_names) ? result.receipt_names : []),
        ]),
      ],
      ready: result.ready === true,
      busy: false,
      error: null,
      artifacts: [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

export async function generateGuestReimbursement(host: GuestReimbursementHost): Promise<void> {
  if (!host.adminBotReimbursement.ready || host.adminBotReimbursement.busy) {
    return;
  }
  host.adminBotReimbursement = { ...host.adminBotReimbursement, busy: true, error: null };
  try {
    const result = (await guestReimbursementRequest(
      host.guestReimbursementBaseUrl,
      "/reimbursements/generate",
      {
        draft: host.adminBotReimbursement.draft,
        ...(host.adminBotReimbursement.funder ? { funder: host.adminBotReimbursement.funder } : {}),
      },
    )) as ReimbursementGenerationResult;
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
      submissionProof: result.submission_proof,
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

async function receiptPayload(file: File) {
  const mediaType = resolveReceiptMediaType(file);
  if (!mediaType) {
    throw new Error(`${file.name} is not a PDF, PNG, or JPEG file`);
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error(`${file.name} exceeds 12 MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { name: file.name, media_type: mediaType, data_base64: btoa(binary) };
}
