// Member nudges and escalations.
//
// Controller for this zone: loads through api/nudges.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import { sendMemberNudge } from "../api/nudges.ts";
import {
  loadStoredMemberSession,
  type MemberNudgeChannel,
  type MemberNudgeDelivery,
  type MemberNudgeResult,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotHost,
  type AdminBotMemberNudgeState,
  loadAdminBot,
} from "./admin.ts";

export function createEmptyAdminBotMemberNudgeState(): AdminBotMemberNudgeState {
  return {
    channel: "slack",
    message: "",
    subject: "",
    selectedMemberIds: [],
    busy: false,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The notice after a send, with the portal and the channel counted apart.
 *
 * They are two different facts. The portal notification is filed before the DM is tried and kept
 * whatever it does, so "notified" is not "sent on Slack" -- and a send whose connector raised is
 * neither sent nor safely unsent, so it is named as unknown rather than folded into either. A
 * service that predates the split sends only `created`/`skipped`, which keeps the old wording.
 */
export function describeMemberNudgeResult(
  result: MemberNudgeResult,
  channel: MemberNudgeChannel,
): { kind: "success" | "error"; text: string } {
  const { created, skipped, deliveries, portal_notified: portalNotified } = result;
  if (!deliveries || !portalNotified) {
    const skippedNote =
      skipped.length > 0
        ? ` Skipped ${skipped.length}: ${skipped.map((entry) => entry.reason).join(", ")}.`
        : "";
    return {
      kind: skipped.length > 0 ? "error" : "success",
      text: `Sent ${plural(created.length, "nudge")}.${skippedNote}`,
    };
  }
  const count = (outcome: MemberNudgeDelivery["outcome"]) =>
    deliveries.filter((entry) => entry.outcome === outcome).length;
  const executed = count("executed");
  const notDelivered = count("not_delivered");
  const failed = count("failed");
  const unknown = count("unknown");
  // Skips that never reached a send: no Slack account, alumni, off the nudge list. A failed or
  // unknown send is also in `skipped`, and is reported under its own outcome instead.
  const attempted = new Set(deliveries.map((entry) => entry.member_id));
  const unsent = skipped.filter((entry) => !attempted.has(entry.member_id));
  const label = channel === "email" ? "email" : "Slack";
  const parts = [
    `Sent ${executed} on ${label}.`,
    `${plural(portalNotified.length, "member")} notified in the portal.`,
  ];
  if (notDelivered > 0) {
    parts.push(`${notDelivered} not delivered (${label} delivery is switched off).`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed before sending.`);
  }
  if (unknown > 0) {
    parts.push(`${unknown} with an unknown outcome: check before sending again.`);
  }
  if (unsent.length > 0) {
    parts.push(`Skipped ${unsent.length}: ${unsent.map((entry) => entry.reason).join(", ")}.`);
  }
  const clean = notDelivered + failed + unknown + unsent.length === 0;
  return { kind: clean ? "success" : "error", text: parts.join(" ") };
}

// Sends the composed Announcements message to every selected recipient. Requires a real admin
// member session (same reasoning as saveAdminBotMember's direct-write path) since the server
// rejects this route outright for the shared service principal. Each recipient becomes its own
// member_nudge.send proposal awaiting pi/lab_manager approval in Pending actions — this never
// sends anything immediately.
export async function sendAdminBotMemberNudge(host: AdminBotHost): Promise<void> {
  host.adminBotNotice = null;
  const draft = host.adminBotMemberNudge;
  if (draft.busy) {
    return;
  }
  const message = draft.message.trim();
  if (!message) {
    host.adminBotNotice = { kind: "error", text: "Enter a message to send." };
    return;
  }
  if (draft.selectedMemberIds.length === 0) {
    host.adminBotNotice = { kind: "error", text: "Select at least one recipient." };
    return;
  }
  if (draft.channel === "email" && !draft.subject.trim()) {
    host.adminBotNotice = { kind: "error", text: "Enter a subject line for the email." };
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to send a nudge.",
    };
    return;
  }
  host.adminBotMemberNudge = { ...draft, busy: true };
  try {
    const result = await sendMemberNudge(
      {
        channel: draft.channel,
        recipient_member_ids: draft.selectedMemberIds,
        message,
        ...(draft.channel === "email" ? { subject: draft.subject.trim() } : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
      return;
    }
    if (!result.ok) {
      const text =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : "Couldn't send this nudge. Check the values and try again.";
      host.adminBotNotice = { kind: "error", text };
      return;
    }
    host.adminBotNotice = describeMemberNudgeResult(result.value, draft.channel);
    host.adminBotMemberNudge = createEmptyAdminBotMemberNudgeState();
    await loadAdminBot(host, undefined, undefined, true);
  } finally {
    if (loadStoredMemberSession()?.sessionToken === stored.sessionToken) {
      host.adminBotMemberNudge = { ...host.adminBotMemberNudge, busy: false };
    }
  }
}
