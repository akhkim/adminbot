import { randomUUID } from "node:crypto";
import {
  adminBotMemberTypes,
  adminBotMemberTypeTokens,
  type AdminBotAuditEvent,
} from "../contracts/actions.js";
import {
  adminBotScheduledMemberChangeMaxDays,
  adminBotScheduledMemberChangeStatuses,
  type AdminBotScheduledMemberChange,
  type AdminBotScheduledMemberChangeNotice,
  type AdminBotScheduledMemberChangeStatus,
} from "../contracts/scheduled-member-changes.js";
import { sameMemberType } from "../workflows/members/roster-sync.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";

// Scheduled member changes: the record of a Member Type change that waits for its day, and the
// bookkeeping around it. Making the change is the route's job (it is the same save the Edit member
// form makes, with the onboarding steps that follow a type); this class decides what is due and
// writes down what happened.

const fail = <T>(status: number, message: string): AdminBotServiceResponse<T> => ({
  ok: false,
  status,
  error: { message },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class ScheduledMemberChangeService {
  constructor(
    private store: AdminBotServiceStore,
    private audit: (event: Omit<AdminBotAuditEvent, "id" | "timestamp">) => void,
    private now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  list(status?: string): AdminBotServiceResponse<{ changes: AdminBotScheduledMemberChange[] }> {
    if (
      status !== undefined &&
      !(adminBotScheduledMemberChangeStatuses as readonly string[]).includes(status)
    ) {
      return fail(400, `status must be one of ${adminBotScheduledMemberChangeStatuses.join(", ")}`);
    }
    return {
      ok: true,
      status: 200,
      payload: {
        changes: this.store.listScheduledMemberChanges(
          status as AdminBotScheduledMemberChangeStatus | undefined,
        ),
      },
    };
  }

  /**
   * Schedules a change. The day is given either as `due_on` or as `after_days` from today -- "a
   * week's grace" is how these are agreed, and nobody should have to do the date arithmetic.
   */
  create(input: unknown, actor: string): AdminBotServiceResponse<AdminBotScheduledMemberChange> {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const memberId = typeof body.member_id === "string" ? body.member_id.trim() : "";
    const member = memberId ? this.store.getLabMember(memberId) : undefined;
    if (!member) {
      return fail(
        memberId ? 404 : 400,
        memberId ? `unknown member ${memberId}` : "member_id is required",
      );
    }
    const tokens = adminBotMemberTypeTokens(
      typeof body.member_type === "string" ? body.member_type : "",
    ).filter(Boolean);
    const unknown = tokens.filter(
      (token) => !(adminBotMemberTypes as readonly string[]).includes(token),
    );
    if (tokens.length === 0 || unknown.length > 0) {
      return fail(
        400,
        tokens.length === 0
          ? "member_type is required"
          : `unknown member type ${unknown.join(", ")}`,
      );
    }
    const memberType = tokens.join(", ");
    if (sameMemberType(member.member_type, memberType)) {
      return fail(409, `${member.name} is already ${memberType}`);
    }
    const hasDueOn = body.due_on !== undefined;
    const hasAfterDays = body.after_days !== undefined;
    if (hasDueOn === hasAfterDays) {
      return fail(400, "give either due_on (YYYY-MM-DD) or after_days, not both");
    }
    const today = this.today();
    let dueOn: string;
    if (hasAfterDays) {
      const days = body.after_days;
      if (
        typeof days !== "number" ||
        !Number.isInteger(days) ||
        days < 0 ||
        days > adminBotScheduledMemberChangeMaxDays
      ) {
        return fail(
          400,
          `after_days must be a whole number from 0 to ${adminBotScheduledMemberChangeMaxDays}`,
        );
      }
      dueOn = new Date(this.now().getTime() + days * DAY_MS).toISOString().slice(0, 10);
    } else {
      dueOn = typeof body.due_on === "string" ? body.due_on.trim() : "";
      const parsed = DATE.test(dueOn) ? new Date(`${dueOn}T00:00:00Z`) : undefined;
      // The round trip catches 2026-02-31, which Date would otherwise roll into March.
      if (
        !parsed ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== dueOn
      ) {
        return fail(400, "due_on must be a date, YYYY-MM-DD");
      }
      const latest = new Date(this.now().getTime() + adminBotScheduledMemberChangeMaxDays * DAY_MS)
        .toISOString()
        .slice(0, 10);
      if (dueOn < today || dueOn > latest) {
        return fail(400, `due_on must be between ${today} and ${latest}`);
      }
    }
    // One waiting change per person: two would race, and the second is nearly always a correction
    // of the first, which is what cancelling is for.
    const waiting = this.store
      .listScheduledMemberChanges("pending")
      .find((change) => change.member_id === member.id);
    if (waiting) {
      return fail(
        409,
        `${member.name} already has a change to ${waiting.member_type} scheduled for ${waiting.due_on}; cancel it first`,
      );
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const change: AdminBotScheduledMemberChange = {
      id: `mchange_${randomUUID()}`,
      member_id: member.id,
      member_type: memberType,
      due_on: dueOn,
      silent: body.silent !== false,
      ...(reason ? { reason } : {}),
      status: "pending",
      created_by: actor,
      created_at: this.now().toISOString(),
    };
    this.store.saveScheduledMemberChange(change);
    this.audit({
      type: "scheduled_member_change.created",
      actor,
      details: {
        change_id: change.id,
        member_id: change.member_id,
        member_type: change.member_type,
        due_on: change.due_on,
        silent: change.silent,
      },
    });
    return { ok: true, status: 201, payload: change };
  }

  cancel(changeId: string, actor: string): AdminBotServiceResponse<AdminBotScheduledMemberChange> {
    const change = this.store.listScheduledMemberChanges().find((entry) => entry.id === changeId);
    if (!change) {
      return fail(404, `unknown scheduled change ${changeId}`);
    }
    if (change.status !== "pending") {
      return fail(409, `this change is already ${change.status}`);
    }
    return {
      ok: true,
      status: 200,
      payload: this.settle(change, "cancelled", `cancelled by ${actor}`, actor),
    };
  }

  /** Pending changes whose day has come, soonest first. */
  due(): AdminBotScheduledMemberChange[] {
    const today = this.today();
    return this.store
      .listScheduledMemberChanges("pending")
      .filter((change) => change.due_on <= today);
  }

  /**
   * Writes down how the member's heads-up went. Re-reads the record first: the send is slow and
   * runs after the response, so a sweep or a cancel may have settled the change meanwhile, and
   * writing back the copy taken at scheduling time would undo that.
   */
  recordNotice(changeId: string, notice: AdminBotScheduledMemberChangeNotice): void {
    const current = this.store.listScheduledMemberChanges().find((entry) => entry.id === changeId);
    if (current) {
      this.store.saveScheduledMemberChange({ ...current, notice });
    }
  }

  /** Takes a change out of `pending` and says why. The audit row is the sweep's receipt. */
  settle(
    change: AdminBotScheduledMemberChange,
    status: Exclude<AdminBotScheduledMemberChangeStatus, "pending">,
    outcome: string,
    actor: string,
  ): AdminBotScheduledMemberChange {
    const settled: AdminBotScheduledMemberChange = {
      ...change,
      status,
      outcome,
      settled_at: this.now().toISOString(),
    };
    this.store.saveScheduledMemberChange(settled);
    this.audit({
      type: `scheduled_member_change.${status}`,
      actor,
      details: {
        change_id: change.id,
        member_id: change.member_id,
        member_type: change.member_type,
        due_on: change.due_on,
        outcome,
      },
    });
    return settled;
  }
}
