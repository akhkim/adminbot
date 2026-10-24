// Recommendation-letter freezes.
//
// The lab's letter policy freezes a member for a year after a desk rejection caused by a
// hallucinated citation. There is no feed that could tell AdminBot that happened, so each one is
// a record an admin enters by hand; the eligibility check reads them and never writes them.
//
// Kept out of actions.ts, which is at its size ratchet. The audit event types stay there, in the
// one union every audit line belongs to.

export const adminBotRecLetterFreezeIncidentKinds = [
  "hallucinated_citation_desk_rejection",
] as const;

export type AdminBotRecLetterFreezeIncidentKind =
  (typeof adminBotRecLetterFreezeIncidentKinds)[number];

export type AdminBotRecLetterFreezeIncidentInput = {
  member_id: string;
  kind: AdminBotRecLetterFreezeIncidentKind;
  /** YYYY-MM-DD: the day of the desk rejection. The freeze runs a year from here. */
  occurred_on: string;
  /** Which paper, when it is one the lab tracks. Free text otherwise belongs in `note`. */
  paper_id?: string;
  /** Admin-only context. Never shown to the member, who sees only the date the freeze ends. */
  note?: string;
};

export type AdminBotRecLetterFreezeIncident = AdminBotRecLetterFreezeIncidentInput & {
  id: string;
  /** The admin who recorded it, as `principalActor` names them. */
  created_by: string;
  created_at: string;
};

/** The store's share of the freezes. Every incident, or one member's, newest `occurred_on` first. */
export type RecLetterFreezeIncidentStore = {
  saveRecLetterFreezeIncident(incident: AdminBotRecLetterFreezeIncident): void;
  listRecLetterFreezeIncidents(memberId?: string): AdminBotRecLetterFreezeIncident[];
  deleteRecLetterFreezeIncident(incidentId: string): boolean;
};
