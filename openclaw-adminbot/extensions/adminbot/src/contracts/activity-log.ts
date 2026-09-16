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

/**
 * One sign-in. Written on the login itself, never on a session refresh or a background sweep.
 *
 * The location fields are the same IPinfo lookup that stamps `last_login_city` on the member row,
 * kept here as well for the one thing a single overwritten field can never answer: where somebody
 * was in March. They are attached a moment *after* the row is inserted (the lookup is a network
 * call and login must not wait on it), so a row with no location is the normal shape for a
 * geolocation that was slow, unconfigured, or looking at a private IP -- not a corruption.
 *
 * Inferred, never stated. A member's own `location` / `current_city` is a different fact and this
 * never becomes it; see the location-source contract in contracts/actions.ts.
 */
export type AdminBotLoginEvent = {
  id: string;
  member_id: string;
  /** ISO-8601. When the credential check succeeded. */
  at: string;
} & AdminBotLoginLocation;

/**
 * Where a sign-in came from, as far as the IP said.
 *
 * Split out from the event because it arrives separately: the row is written first and this is
 * attached when the lookup returns. Every field is optional independently -- the Lite tier of the
 * provider answers with a country and no city, and a country-only stamp is still a usable travel
 * record.
 */
export type AdminBotLoginLocation = {
  country?: string;
  continent?: string;
  city?: string;
  /** IANA zone. Only ever a region/city name -- a bare UTC offset is dropped at the connector. */
  timezone?: string;
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

/**
 * One row of the recent-edits feed: a stored event with the names filled in.
 *
 * The event itself is all ids -- who, which slot, whose record -- because ids survive a rename.
 * A reader wants names, and resolving them in the browser would mean shipping the roster to draw
 * a list of forty edits, so the service joins the two it owns: member names and paper titles.
 *
 * What it deliberately does not resolve is the *field label*. "Location", "arXiv abstract page" is
 * display copy, and the profile field list lives in the Control UI (member-fields.ts) while the
 * slot registry lives in contracts. Sending the key and letting the reader name it keeps the
 * service out of the business of what a field is called this month.
 */
export type AdminBotRecentUpdate = {
  id: string;
  at: string;
  subject: AdminBotUpdateSubject;
  source: AdminBotUpdateSource;
  /** Who typed it. The name is absent when the id is nobody on the roster any more. */
  actor_member_id: string;
  actor_name?: string;
  /** Whose record it was, when that is somebody other than the actor. */
  subject_member_id?: string;
  subject_member_name?: string;
  /** The paper it landed on, for the two paper subjects. */
  paper_id?: string;
  paper_title?: string;
  /** `location` for a profile field, `arxiv` for a paper slot, absent for a paper record edit. */
  field_key?: string;
  /** The raw slot id, so a reader can group or link by it without re-deriving it. */
  slot_id: string;
};

/**
 * The pieces of a `slot_id`, or undefined when it is not one this build knows how to read.
 *
 * Built rather than split at the call site: the three id shapes are declared right above, and a
 * reader that splits on ":" by hand gets `paper_slot:paper-1:arxiv` wrong the moment a paper id
 * contains a colon.
 */
export function parseSlotId(
  slotId: string,
): { subject: AdminBotUpdateSubject; paperId?: string; field?: string } | undefined {
  if (slotId.startsWith("profile:")) {
    return { subject: "profile", field: slotId.slice("profile:".length) };
  }
  if (slotId.startsWith("paper_slot:")) {
    const rest = slotId.slice("paper_slot:".length);
    // The slot name is the last segment; everything before it is the paper id, which may itself
    // contain a colon.
    const cut = rest.lastIndexOf(":");
    if (cut === -1) {
      return undefined;
    }
    return { subject: "paper_slot", paperId: rest.slice(0, cut), field: rest.slice(cut + 1) };
  }
  if (slotId.startsWith("paper:")) {
    return { subject: "paper", paperId: slotId.slice("paper:".length) };
  }
  return undefined;
}
