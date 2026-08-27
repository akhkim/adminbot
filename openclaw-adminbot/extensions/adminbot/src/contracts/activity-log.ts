/**
 * Append-only logs of two things the roster could previously only guess at: who signed in, and who
 * changed a piece of the lab's own record.
 *
 * Both already had a *latest* stamp before this -- `last_login_at` on the member, and
 * `provided_by_member_id` / `provided_at` on a paper slot. A latest stamp answers "is this person
 * alive" and nothing else. It cannot say how often somebody comes back, it is destroyed by the next
 * write, and a bulk importer that touches every row erases the entire history of who actually did
 * the work. That is not hypothetical: the 2026-08 credential provisioning left 145 members holding
 * byte-identical timestamps, and no way to tell a real sign-in from a script's.
 *
 * So these are events, not fields. Nothing here is ever updated or deleted in the normal course of
 * running; a row is a fact about a moment, and the moment does not change.
 */

/** One sign-in. Written on the login itself, never on a session refresh or a background sweep. */
export type AdminBotLoginEvent = {
  id: string;
  member_id: string;
  /** ISO-8601. When the credential check succeeded. */
  at: string;
};

/**
 * What kind of thing a `slot_id` names.
 *
 * Two writers share one table because the question they answer is one question -- "who filled this
 * in" -- and answering it per-member across both kinds should be one query, not a union of two
 * shapes that drift apart.
 */
export type AdminBotUpdateSubject = "profile" | "paper" | "paper_slot";

/**
 * One member changing one field of one thing.
 *
 * `slot_id` is namespaced by subject so the column is unique across both writers:
 * `profile:<field>` and `paper_slot:<paper_id>:<slot>`. Build it with {@link profileSlotId} /
 * {@link paperSlotId} rather than by hand -- a hand-built id that disagrees by one character is a
 * row that silently never joins back to anything.
 *
 * `source` is who was typing, not who owns the record: an admin correcting somebody else's profile
 * is `admin`, and it is the distinction the adoption rate is built on. A field an admin filled in
 * is data the lab has; a field the member filled in is data the member adopted, and only the second
 * one means the tool landed.
 */
export type AdminBotUpdateEvent = {
  id: string;
  subject: AdminBotUpdateSubject;
  slot_id: string;
  /** Who made the change. The acting member, never the record's owner. */
  member_id: string;
  /** ISO-8601. */
  at: string;
  source: AdminBotUpdateSource;
  /**
   * The member whose record was touched, when that is somebody other than the actor. Absent on a
   * self-edit, which keeps "did they do it themselves" a null check rather than a comparison.
   */
  subject_member_id?: string;
};

/** `import` is the nightly/bulk sync. It is a value so imported data can never look self-authored. */
export type AdminBotUpdateSource = "member" | "admin" | "import";

export function profileSlotId(field: string): string {
  return `profile:${field}`;
}

export function paperSlotId(paperId: string, slot: string): string {
  return `paper_slot:${paperId}:${slot}`;
}

/**
 * The paper record itself, as opposed to one of its evidence slots.
 *
 * One event per save rather than one per changed field, unlike a profile. A paper's fields are
 * nested and rebuilt wholesale on every write (`artifacts`, `author_links`, `reminder`), so a
 * field-level diff would report churn that nobody edited. The question this has to answer is "who
 * last touched this paper, and when" -- and for that the paper is the right grain.
 */
export function paperRecordSlotId(paperId: string): string {
  return `paper:${paperId}`;
}
