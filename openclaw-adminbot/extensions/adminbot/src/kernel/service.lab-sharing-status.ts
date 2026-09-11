import { randomUUID } from "node:crypto";
import {
  ADMINBOT_BROADCAST_HISTORY_LIMIT,
  currentBroadcast,
  type LabDirectorStatus,
  validateDirectorStatus,
} from "../contracts/lab-sharing-status.js";
import type { AdminBotServiceStore } from "./service.js";

type StatusStore = Pick<
  AdminBotServiceStore,
  "getLabMember" | "readDirectorStatus" | "saveDirectorStatus" | "listDirectorStatusHistory" | "recordAudit"
>;
const denied = () => ({
  ok: false as const,
  status: 403,
  error: { message: "A member administrator is required." },
});

/**
 * What the lab has been told, and who may tell it.
 *
 * Publishing is admin-only; reading is not. A broadcast is addressed to every member by definition,
 * so gating the archive behind admin would hide from its own audience the thing it was sent to say.
 * Being on the roster at all is the whole check.
 */
export class LabSharingStatusService {
  constructor(
    private store: StatusStore,
    private clock: () => number = Date.now,
  ) {}
  read(memberId: string) {
    const member = this.store.getLabMember(memberId);
    if (!member) return denied();
    const history = this.store.listDirectorStatusHistory(ADMINBOT_BROADCAST_HISTORY_LIMIT);
    return {
      ok: true as const,
      status: 200,
      payload: {
        status: currentBroadcast(history, this.clock()),
        history,
        can_manage: member.privilege_level === "admin",
      },
    };
  }
  save(memberId: string, input: unknown, clear = false) {
    if (this.store.getLabMember(memberId)?.privilege_level !== "admin") return denied();
    const now = this.clock();
    const draft = clear ? null : validateDirectorStatus(input, now);
    if (typeof draft === "string")
      return { ok: false as const, status: 400, error: { message: draft } };
    const timestamp = new Date(now).toISOString();
    const published: LabDirectorStatus | null = draft
      ? { ...draft, id: `bcast_${randomUUID()}`, updated_at: timestamp, updated_by: memberId }
      : null;
    this.store.saveDirectorStatus(published);
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp,
      type: clear ? "lab_status.cleared" : "lab_status.saved",
      actor: memberId,
      // The id, so the audit row points at the broadcast it is about -- the archive keeps every
      // entry now, and "which one" stopped being answerable from the timestamp alone.
      details: published ? { broadcast_id: published.id } : {},
    });
    return this.read(memberId);
  }
}
