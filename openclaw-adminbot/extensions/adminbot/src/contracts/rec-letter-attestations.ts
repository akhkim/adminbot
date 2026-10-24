// Recommendation-letter attestations.
//
// The eligibility check reads committed hours off the availability page and attendance off the
// meeting rosters, and both can be incomplete for reasons that say nothing about the member: the
// page did not exist when they started, or nobody exported the roster. An admin who knows the
// member met a criterion records that here, with a note, and the check counts the criterion as met
// and labels it as confirmed by an admin rather than computed.
//
// Advisory like the rest of the check. Kept out of actions.ts, which is at its size ratchet; the
// audit event types stay there, in the one union every audit line belongs to.

export const adminBotRecLetterAttestationCriteria = ["hours", "attendance"] as const;

export type AdminBotRecLetterAttestationCriterion =
  (typeof adminBotRecLetterAttestationCriteria)[number];

export type AdminBotRecLetterAttestationInput = {
  member_id: string;
  criterion: AdminBotRecLetterAttestationCriterion;
  /** Why the admin is confirming it. Admin-only; the member sees only that it was confirmed. */
  note?: string;
};

export type AdminBotRecLetterAttestation = AdminBotRecLetterAttestationInput & {
  id: string;
  /** The admin who recorded it, as `principalActor` names them. */
  created_by: string;
  created_at: string;
};

/** The store's share of the attestations. Every one, or one member's, newest first. */
export type RecLetterAttestationStore = {
  saveRecLetterAttestation(attestation: AdminBotRecLetterAttestation): void;
  listRecLetterAttestations(memberId?: string): AdminBotRecLetterAttestation[];
  deleteRecLetterAttestation(attestationId: string): boolean;
};
