import { randomUUID } from "node:crypto";
import { currentDirectorStatus, validateDirectorStatus } from "../contracts/lab-sharing-status.js";
import type { AdminBotServiceStore } from "./service.js";

type StatusStore = Pick<
  AdminBotServiceStore,
  "getLabMember" | "readDirectorStatus" | "saveDirectorStatus" | "recordAudit"
>;
const denied = () => ({
  ok: false as const,
  status: 403,
  error: { message: "A member administrator is required." },
});
export class LabSharingStatusService {
  constructor(
    private store: StatusStore,
    private clock: () => number = Date.now,
  ) {}
  read(memberId: string) {
    const member = this.store.getLabMember(memberId);
    if (!member) return denied();
    const status = currentDirectorStatus(this.store.readDirectorStatus(), this.clock());
    return {
      ok: true as const,
      status: 200,
      payload: { status, can_manage: member.privilege_level === "admin" },
    };
  }
  save(memberId: string, input: unknown, clear = false) {
    if (this.store.getLabMember(memberId)?.privilege_level !== "admin") return denied();
    const now = this.clock();
    const draft = clear ? null : validateDirectorStatus(input, now);
    if (typeof draft === "string")
      return { ok: false as const, status: 400, error: { message: draft } };
    const timestamp = new Date(now).toISOString();
    this.store.saveDirectorStatus(
      draft ? { ...draft, updated_at: timestamp, updated_by: memberId } : null,
    );
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp,
      type: clear ? "lab_status.cleared" : "lab_status.saved",
      actor: memberId,
      details: {},
    });
    return this.read(memberId);
  }
}
