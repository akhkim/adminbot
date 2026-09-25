/**
 * Requests to add somebody to the roster, from the Lab Members tab.
 *
 * A member who is not an admin can propose a new member; the request waits until an admin
 * approves or rejects it (POST /lab/members/requests and friends in the service). An admin sees
 * every request, anyone else sees only their own -- the service decides that, not this file.
 */
import {
  approveMemberRequest,
  fetchMemberRequests,
  loadStoredMemberSession,
  type MemberRequestInput,
  type MemberRequestView,
  queueMemberOnboardingGuide,
  rejectMemberRequest,
  resolveAdminBotBaseUrl,
  submitMemberRequest,
  withdrawMemberRequest,
  type AuthResult,
} from "../auth/session.ts";
import { ADMINBOT_SERVICE_UNREACHABLE_MESSAGE, type AdminBotHost, loadAdminBot } from "./admin.ts";

export type AdminBotMemberRequestsState = {
  requests: MemberRequestView[];
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  /** The request a decision is in flight for, so its buttons cannot be pressed twice. */
  busyId: string | null;
};

export function createEmptyAdminBotMemberRequests(): AdminBotMemberRequestsState {
  return { requests: [], loading: false, error: null, loadedAt: null, busyId: null };
}

export type AdminBotMemberRequestsHost = Pick<
  AdminBotHost,
  "settings" | "adminBotNotice" | "requestUpdate"
> & {
  adminBotMemberRequests: AdminBotMemberRequestsState;
};

type Notice = NonNullable<AdminBotHost["adminBotNotice"]>;

const success = (text: string): Notice => ({ kind: "success", text });
const failure = (text: string): Notice => ({ kind: "error", text });

function failureText(result: Extract<AuthResult<unknown>, { ok: false }>, fallback: string) {
  if (result.kind === "unreachable") {
    return ADMINBOT_SERVICE_UNREACHABLE_MESSAGE;
  }
  if (result.kind === "rate-limited") {
    return "Too many attempts. Wait a moment and try again.";
  }
  return result.message ?? fallback;
}

export async function loadAdminBotMemberRequests(host: AdminBotMemberRequestsHost): Promise<void> {
  const session = loadStoredMemberSession();
  if (!session) {
    return;
  }
  const pending = { ...host.adminBotMemberRequests, loading: true, error: null };
  host.adminBotMemberRequests = pending;
  const result = await fetchMemberRequests(
    session.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (
    host.adminBotMemberRequests !== pending ||
    loadStoredMemberSession()?.sessionToken !== session.sessionToken
  ) {
    return;
  }
  host.adminBotMemberRequests = result.ok
    ? { ...pending, requests: result.value, loading: false, loadedAt: Date.now() }
    : {
        ...pending,
        loading: false,
        error: failureText(result, "Could not load member requests."),
      };
}

/** A non-admin's Add member: files the request and says it is waiting, rather than "saved". */
export async function submitAdminBotMemberRequest(
  host: AdminBotMemberRequestsHost,
  input: MemberRequestInput,
): Promise<boolean> {
  host.adminBotNotice = null;
  const session = loadStoredMemberSession();
  if (!session) {
    host.adminBotNotice = failure("Sign in to add a member.");
    return false;
  }
  const result = await submitMemberRequest(
    input,
    session.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (loadStoredMemberSession()?.sessionToken !== session.sessionToken) {
    return false;
  }
  if (!result.ok) {
    host.adminBotNotice = failure(
      failureText(result, "Couldn't send this request. Check the values and try again."),
    );
    return false;
  }
  host.adminBotNotice = success(
    `Sent ${input.name} to the admins for review. They join the roster once an admin approves.`,
  );
  await loadAdminBotMemberRequests(host);
  return true;
}

async function decide(
  host: AdminBotMemberRequestsHost,
  requestId: string,
  run: (sessionToken: string, baseUrl: string) => Promise<Notice>,
): Promise<void> {
  host.adminBotNotice = null;
  const session = loadStoredMemberSession();
  if (!session || host.adminBotMemberRequests.busyId) {
    return;
  }
  host.adminBotMemberRequests = { ...host.adminBotMemberRequests, busyId: requestId };
  host.requestUpdate?.();
  try {
    const notice = await run(session.sessionToken, resolveAdminBotBaseUrl(host.settings));
    if (loadStoredMemberSession()?.sessionToken !== session.sessionToken) {
      return;
    }
    host.adminBotNotice = notice;
  } finally {
    host.adminBotMemberRequests = { ...host.adminBotMemberRequests, busyId: null };
  }
  await loadAdminBotMemberRequests(host);
}

/**
 * Approves a request: the service writes the member exactly as an admin's own Add member would.
 * `onboard` then queues their onboarding guide for approval, the same second step that form takes.
 */
export async function approveAdminBotMemberRequest(
  host: AdminBotMemberRequestsHost & AdminBotHost,
  request: MemberRequestView,
  options: { onboard: boolean },
): Promise<void> {
  let approved = false;
  await decide(host, request.id, async (token, baseUrl) => {
    const result = await approveMemberRequest(request.id, token, baseUrl);
    if (!result.ok) {
      return failure(failureText(result, `Couldn't approve ${request.profile.name}.`));
    }
    approved = true;
    const added = `Added ${request.profile.name} to the roster.`;
    if (!options.onboard) {
      return success(added);
    }
    const memberId = result.value.request.member_id ?? result.value.member.id;
    if (!memberId) {
      return failure(`${added} Start their onboarding from their row.`);
    }
    const guide = await queueMemberOnboardingGuide(memberId, token, baseUrl);
    return guide.ok
      ? success(`${added} Their onboarding guide is queued for approval.`)
      : failure(
          `${added} The onboarding guide was not queued: ${failureText(guide, "the service refused it")}. Start it from their row.`,
        );
  });
  if (approved) {
    await loadAdminBot(host);
  }
}

export async function rejectAdminBotMemberRequest(
  host: AdminBotMemberRequestsHost,
  request: MemberRequestView,
  note: string,
): Promise<void> {
  await decide(host, request.id, async (token, baseUrl) => {
    const result = await rejectMemberRequest(request.id, note.trim(), token, baseUrl);
    return result.ok
      ? success(`Declined the request to add ${request.profile.name}.`)
      : failure(failureText(result, `Couldn't decline ${request.profile.name}.`));
  });
}

export async function withdrawAdminBotMemberRequest(
  host: AdminBotMemberRequestsHost,
  request: MemberRequestView,
): Promise<void> {
  await decide(host, request.id, async (token, baseUrl) => {
    const result = await withdrawMemberRequest(request.id, token, baseUrl);
    return result.ok
      ? success(`Withdrew your request to add ${request.profile.name}.`)
      : failure(failureText(result, "Couldn't withdraw that request."));
  });
}
