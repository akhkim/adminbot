import { randomUUID } from "node:crypto";
import type { AdminBotAuditEvent, AdminBotLabMember } from "../contracts/actions.js";
import type { AdminBotRecLetterAttestation } from "../contracts/rec-letter-attestations.js";
import type { AdminBotRecLetterFreezeIncident } from "../contracts/rec-letter-freezes.js";
import {
  adminBotRecLetterSummaryLimit,
  parseRecLetterAttestationInput,
  parseRecLetterFreezeIncidentInput,
  recLetterEligibility,
  redactRecLetterEligibilityForMember,
  type RecLetterEligibility,
  type RecLetterEligibilityStatus,
} from "../workflows/logistics/rec-letter-eligibility.js";
import type { AdminBotServiceResponse, AdminBotServiceStore } from "./service.js";

// Recommendation-letter eligibility: the freeze incidents and attestations an admin records, and
// the reads that turn them, the meeting rosters and the availability rows into a verdict.
//
// Advisory: nothing here blocks a request. The admin reads the full result next to the request
// it concerns; a member reads only their own, without the incident records behind a freeze.

const fail = <T>(status: number, message: string): AdminBotServiceResponse<T> => ({
  ok: false,
  status,
  error: { message },
});

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecLetterEligibilitySummaryRow = {
  member_id: string;
  status: RecLetterEligibilityStatus;
  frozen_until?: string;
};

export class RecLetterEligibilityService {
  constructor(
    private store: AdminBotServiceStore,
    private audit: (event: Omit<AdminBotAuditEvent, "id" | "timestamp">) => void,
    private now: () => Date = () => new Date(),
  ) {}

  private evaluate(
    member: AdminBotLabMember,
    incidents: AdminBotRecLetterFreezeIncident[],
    attestations: AdminBotRecLetterAttestation[],
  ): RecLetterEligibility {
    return recLetterEligibility({
      member,
      incidents,
      attestations,
      meetings: this.store.listMeetings(),
      now: this.now(),
    });
  }

  /** Every freeze on file, or one member's. Admin-only at the route; notes included. */
  listIncidents(
    memberId?: string,
  ): AdminBotServiceResponse<{ incidents: AdminBotRecLetterFreezeIncident[] }> {
    return {
      ok: true,
      status: 200,
      payload: { incidents: this.store.listRecLetterFreezeIncidents(memberId) },
    };
  }

  /**
   * Records a freeze. The date is the desk rejection's, not today's, so it may be in the past; it
   * may not be in the future, which is a typo rather than an incident.
   */
  createIncident(
    input: unknown,
    actor: string,
  ): AdminBotServiceResponse<AdminBotRecLetterFreezeIncident> {
    const parsed = parseRecLetterFreezeIncidentInput(input);
    if (!parsed.ok) {
      return fail(400, parsed.error);
    }
    if (!this.store.getLabMember(parsed.value.member_id)) {
      return fail(404, `unknown member ${parsed.value.member_id}`);
    }
    const now = this.now();
    // A day of slack for time zones: an incident entered in Zurich on the morning of the 17th is
    // still the 16th in Toronto.
    const latestAllowed = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
    if (parsed.value.occurred_on > latestAllowed) {
      return fail(400, "occurred_on cannot be in the future");
    }
    const incident: AdminBotRecLetterFreezeIncident = {
      ...parsed.value,
      id: `rlfreeze_${randomUUID()}`,
      created_by: actor,
      created_at: now.toISOString(),
    };
    this.store.saveRecLetterFreezeIncident(incident);
    // The note stays out of the audit log: it may describe the paper, and the log is read more
    // widely than the incident list.
    this.audit({
      type: "rec_letter_freeze.recorded",
      actor,
      details: {
        incident_id: incident.id,
        member_id: incident.member_id,
        occurred_on: incident.occurred_on,
      },
    });
    return { ok: true, status: 201, payload: incident };
  }

  deleteIncident(
    incidentId: string,
    actor: string,
  ): AdminBotServiceResponse<{ deleted: true; id: string }> {
    const existing = this.store
      .listRecLetterFreezeIncidents()
      .find((incident) => incident.id === incidentId);
    if (!existing || !this.store.deleteRecLetterFreezeIncident(incidentId)) {
      return fail(404, `unknown freeze incident ${incidentId}`);
    }
    this.audit({
      type: "rec_letter_freeze.deleted",
      actor,
      details: {
        incident_id: existing.id,
        member_id: existing.member_id,
        occurred_on: existing.occurred_on,
      },
    });
    return { ok: true, status: 200, payload: { deleted: true, id: incidentId } };
  }

  /** Every attestation on file, or one member's. Admin-only at the route; notes included. */
  listAttestations(
    memberId?: string,
  ): AdminBotServiceResponse<{ attestations: AdminBotRecLetterAttestation[] }> {
    return {
      ok: true,
      status: 200,
      payload: { attestations: this.store.listRecLetterAttestations(memberId) },
    };
  }

  /**
   * Records an admin's confirmation that a member meets one criterion -- for the months the
   * availability page never saw, or the meetings nobody exported a roster for. It counts the
   * criterion as met and is labelled as confirmed, never passed off as computed.
   */
  createAttestation(
    input: unknown,
    actor: string,
  ): AdminBotServiceResponse<AdminBotRecLetterAttestation> {
    const parsed = parseRecLetterAttestationInput(input);
    if (!parsed.ok) {
      return fail(400, parsed.error);
    }
    if (!this.store.getLabMember(parsed.value.member_id)) {
      return fail(404, `unknown member ${parsed.value.member_id}`);
    }
    const attestation: AdminBotRecLetterAttestation = {
      ...parsed.value,
      id: `rlattest_${randomUUID()}`,
      created_by: actor,
      created_at: this.now().toISOString(),
    };
    this.store.saveRecLetterAttestation(attestation);
    // As with freezes, the note stays out of the audit log, which is read more widely.
    this.audit({
      type: "rec_letter_attestation.recorded",
      actor,
      details: {
        attestation_id: attestation.id,
        member_id: attestation.member_id,
        criterion: attestation.criterion,
      },
    });
    return { ok: true, status: 201, payload: attestation };
  }

  deleteAttestation(
    attestationId: string,
    actor: string,
  ): AdminBotServiceResponse<{ deleted: true; id: string }> {
    const existing = this.store
      .listRecLetterAttestations()
      .find((attestation) => attestation.id === attestationId);
    if (!existing || !this.store.deleteRecLetterAttestation(attestationId)) {
      return fail(404, `unknown attestation ${attestationId}`);
    }
    this.audit({
      type: "rec_letter_attestation.deleted",
      actor,
      details: {
        attestation_id: existing.id,
        member_id: existing.member_id,
        criterion: existing.criterion,
      },
    });
    return { ok: true, status: 200, payload: { deleted: true, id: attestationId } };
  }

  /**
   * The admin's view of one member: the full result, the incidents behind any freeze and the
   * attestations behind any confirmed criterion.
   *
   * Reached by member id, or by the id of a request that member made -- which is how the request
   * detail asks, without the UI having to know whose request it is reading.
   */
  forAdmin(target: { member_id?: string; request_id?: string }): AdminBotServiceResponse<{
    member: { id: string; name: string };
    eligibility: RecLetterEligibility;
    incidents: AdminBotRecLetterFreezeIncident[];
    attestations: AdminBotRecLetterAttestation[];
  }> {
    let memberId = target.member_id?.trim();
    const requestId = target.request_id?.trim();
    if (!memberId && requestId) {
      const request = this.store.getLogisticsRequest(requestId);
      if (!request) {
        return fail(404, `unknown logistics request ${requestId}`);
      }
      memberId = request.member_id;
    }
    if (!memberId) {
      return fail(400, "member_id or request_id is required");
    }
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return fail(404, `unknown member ${memberId}`);
    }
    const incidents = this.store.listRecLetterFreezeIncidents(member.id);
    const attestations = this.store.listRecLetterAttestations(member.id);
    return {
      ok: true,
      status: 200,
      payload: {
        member: { id: member.id, name: member.name },
        eligibility: this.evaluate(member, incidents, attestations),
        incidents,
        attestations,
      },
    };
  }

  /**
   * The verdict alone for a page of members, for the badge on each row of the admin queue.
   *
   * A separate read rather than a column on the list rows: the list is cached by an etag over the
   * requests, and eligibility moves with meetings and availability that the etag knows nothing
   * about. Unknown ids are skipped rather than failing the page.
   */
  summaries(
    memberIds: readonly string[],
  ): AdminBotServiceResponse<{ summaries: RecLetterEligibilitySummaryRow[] }> {
    const unique = [...new Set(memberIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length > adminBotRecLetterSummaryLimit) {
      return fail(400, `at most ${adminBotRecLetterSummaryLimit} member ids per read`);
    }
    const incidents = this.store.listRecLetterFreezeIncidents();
    const attestations = this.store.listRecLetterAttestations();
    const summaries = unique.flatMap((memberId): RecLetterEligibilitySummaryRow[] => {
      const member = this.store.getLabMember(memberId);
      if (!member) {
        return [];
      }
      const result = this.evaluate(member, incidents, attestations);
      return [
        {
          member_id: member.id,
          status: result.status,
          ...(result.freeze.frozen && result.freeze.frozen_until
            ? { frozen_until: result.freeze.frozen_until }
            : {}),
        },
      ];
    });
    return { ok: true, status: 200, payload: { summaries } };
  }

  /**
   * The signed-in member's own result, with the lab's records taken out: whether they are frozen
   * and until when, never which incident or what the admin wrote about it.
   */
  own(memberId: string): AdminBotServiceResponse<RecLetterEligibility> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return fail(404, `unknown member ${memberId}`);
    }
    const result = this.evaluate(
      member,
      this.store.listRecLetterFreezeIncidents(member.id),
      this.store.listRecLetterAttestations(member.id),
    );
    return { ok: true, status: 200, payload: redactRecLetterEligibilityForMember(result) };
  }
}
