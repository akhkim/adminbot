// AdminBot client: The lab roster: own profile and schedule writes, administrator edits, requests, overviews.
//
// Mirrors the service's api/routes/members.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  authedJson,
  type AuthResult,
  calendarFailure,
  type LabMember,
  mapErrorResponse,
  type MemberTypeChangeSummary,
  readRecentUpdates,
  type RecentUpdateRow,
} from "../auth/session.ts";

// Whitelisted self-editable profile fields. privilege_level/status/email are
// governance-owned and must never be sent from a member's own profile form.
export type MemberProfileUpdate = {
  name?: string;
  calendar_email?: string;
  slack_user_id?: string;
  role?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  // The schedule is not a profile field: it is the row lists MemberScheduleUpdate carries, and the
  // service validates it as such. A free-text `availability` string used to live here, and the Lab
  // Members form sent it empty on every save, so the service answered 400 "member availability must
  // be a list" and the whole edit was lost.
  location?: string;
  current_city?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  openreview_id?: string;
  // The link only. cv_snapshot is not writable here: the service owns it, and a member who could
  // set it could hide or invent their own career changes.
  cv_url?: string;
  intake_form_url?: string;
  intake_form_unavailable?: boolean;
  arr_reviewer_qualified?: boolean | null;
  arr_review_capacity?: number | null;
  linkedin_url?: string;
  twitter_url?: string;
  github_url?: string;
  scholar_url?: string;
  avatar_url?: string;
  notes?: string;
  // Promoted out of the notes line convention; see migrateMemberNotesToFields in the service.
  joined_month?: string;
  whatsapp?: string;
};

// Full governance-capable payload for an admin editing ANY member (including
// privilege_level/status/email). Only sent when the caller is a genuine admin
// member Bearer session — the server independently re-verifies this and
// rejects governance fields from any other principal (service token, non-admin
// member self-edit), so this type being permissive here is not itself a trust
// boundary.
export type AdminLabMemberUpdate = {
  /**
   * Ids of the standing meetings to be on, from the Meetings checkboxes. Applied to the calendar,
   * never stored on the record; sent only when the list was loaded.
   */
  meetings?: string[];
  name?: string;
  email?: string;
  slack_user_id?: string;
  privilege_level?: string;
  collaborator_subgroup?: string;
  status?: string;
  role?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  notes?: string;
};

// Self-service profile edit (PUT /lab/members/:id) with the member session. Only
// whitelisted profile fields are sent; email/privilege_level/status stay out.
export async function updateOwnProfile(
  memberId: string,
  fields: MemberProfileUpdate,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    fields,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

// A single commitment row on a member's schedule. Mirrors AdminBotAvailabilityRow in
// extensions/adminbot/src/contracts/actions.ts, and AvailabilityRow in ../data/availability.ts —
// copied rather than imported for the same reason the privilege levels are: the auth layer does
// not reach across into either the extensions boundary or the view layer.
export type MemberAvailabilityRow = {
  start: string;
  end: string;
  project?: string;
  hours_per_week: number;
  note?: string;
  link?: string;
};

export type MemberTimeOffRow = {
  start: string;
  end: string;
  // Optional here only because the lists sent back are composed from stored rows, whose parsed
  // shape treats `kind` as absent-able. The service rejects any row whose kind is not one of
  // adminBotTimeOffKinds, so a row without one never lands.
  kind?: string;
  availability: "none" | "partial";
  note?: string;
  label?: string;
  link?: string;
};

export type MemberMilestoneRow = {
  deadline_id?: string;
  date: string;
  label: string;
  link?: string;
  time?: string;
  timezone?: string;
};

/**
 * The three schedule lists, any subset of which may be sent.
 *
 * An omitted list is left alone; a list sent as `[]` clears that part of the schedule outright
 * (the service deletes an empty array rather than storing one, so it reads as "nothing recorded"
 * rather than as an empty chart).
 */
export type MemberTripRow = {
  start: string;
  end: string;
  city: string;
  timezone?: string;
  note?: string;
  link?: string;
};

export type MemberScheduleUpdate = {
  availability?: MemberAvailabilityRow[];
  time_off?: MemberTimeOffRow[];
  milestones?: MemberMilestoneRow[];
  trips?: MemberTripRow[];
  dismissed_deadlines?: string[];
  // The overall note that explains the rows: a sentence or two for the admins, sent on its own
  // (every other key omitted) so saving it can never rewrite a list. "" clears it -- the service
  // deletes an emptied note rather than storing a blank one.
  availability_notes?: string;
};

/**
 * Self-service schedule edit (PUT /lab/members/:id) with the member session.
 *
 * Deliberately separate from `updateOwnProfile`: a schedule is whole lists of validated rows
 * (SELF_PROFILE_EDITABLE_FIELDS and validateAvailability in
 * extensions/adminbot/src/kernel/service.ts), while a profile update is scalar fields. They were
 * once the same field — `MemberProfileUpdate.availability` as free text — and the profile forms
 * kept sending that string over the list the service expects, failing every save with 400 "member
 * availability must be a list".
 *
 * All three lists are self-editable, so this needs no approval gate — but the service still
 * re-validates everything (date ranges, 0–168 hours, https-only links, 200-row caps) and stamps
 * `availability_updated_at`. The UI never writes another member's schedule; the server enforces it.
 */
export async function updateOwnSchedule(
  memberId: string,
  patch: MemberScheduleUpdate,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    patch,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

// Admin write for ANY member (self or otherwise), including governance fields.
// Uses the signed-in admin's own member Bearer session — the server routes a
// real admin member session to the full write path, unlike the shared service
// principal (which every gateway-tool call authenticates as and which is
// deliberately restricted to the same whitelist as a plain self-edit).
export async function upsertLabMemberAsAdmin(
  memberId: string,
  fields: AdminLabMemberUpdate,
  sessionToken: string,
  baseUrl: string,
  create = false,
): Promise<
  AuthResult<
    LabMember & {
      member_type_change?: MemberTypeChangeSummary;
      meeting_changes?: MemberTypeChangeSummary["steps"];
    }
  >
> {
  const result = await authedJson(
    baseUrl,
    create ? "/lab/members" : `/lab/members/${encodeURIComponent(memberId)}`,
    create ? "POST" : "PUT",
    sessionToken,
    create ? { ...fields, ...(memberId ? { id: memberId } : {}) } : fields,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // The service only grants the full governance write to an admin member
    // session (extensions/adminbot/src/api/server.ts) — a session that has lost that
    // privilege gets 403, mapped to `forbidden` rather than the generic auth-failed.
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as LabMember & {
      member_type_change?: MemberTypeChangeSummary;
      meeting_changes?: MemberTypeChangeSummary["steps"];
    },
  };
}

/**
 * Delete one roster row and everything that named it.
 *
 * Member session only, for a stronger version of the merge's reason: a merge keeps the person's
 * history under the surviving id and this keeps none of it. `force` is the caller passing on an
 * admin's explicit second decision about an account that can still be signed into -- never a
 * retry the UI sends by itself when the first call comes back 409.
 */
export async function deleteLabMemberAsAdmin(
  memberId: string,
  sessionToken: string,
  baseUrl: string,
  options: { force?: boolean } = {},
): Promise<
  AuthResult<{ deleted_id: string; deleted_name: string; removed: Record<string, number> }>
> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}`,
    "DELETE",
    sessionToken,
    { force: options.force === true },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as {
      deleted_id: string;
      deleted_name: string;
      removed: Record<string, number>;
    },
  };
}

export async function fetchMembersWithoutEmail(
  sessionToken: string,
  baseUrl: string,
): Promise<
  AuthResult<{
    deletable: Array<{ id: string; name: string; attached_rows: number }>;
    blocked: Array<{ id: string; name: string; reason: string }>;
  }>
> {
  const result = await authedJson(baseUrl, "/lab/members/without-email", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as {
      deletable: Array<{ id: string; name: string; attached_rows: number }>;
      blocked: Array<{ id: string; name: string; reason: string }>;
    },
  };
}

/**
 * Delete every member the lab has no address for.
 *
 * `dryRun` defaults to true here as well as in the service, so a caller that forgets the argument
 * previews rather than deletes -- the destructive reading of an ambiguous call is the wrong one to
 * make twice.
 */
export async function purgeMembersWithoutEmailAsAdmin(
  sessionToken: string,
  baseUrl: string,
  options: { dryRun?: boolean } = {},
): Promise<
  AuthResult<{
    deleted: Array<{ id: string; name: string }>;
    blocked: Array<{ id: string; name: string; reason: string }>;
    removed: Record<string, number>;
    dry_run: boolean;
  }>
> {
  const result = await authedJson(
    baseUrl,
    "/lab/members/without-email/purge",
    "POST",
    sessionToken,
    { dry_run: options.dryRun !== false },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as {
      deleted: Array<{ id: string; name: string }>;
      blocked: Array<{ id: string; name: string; reason: string }>;
      removed: Record<string, number>;
      dry_run: boolean;
    },
  };
}

/**
 * Fold one roster row into another.
 *
 * Member session only, like every other governance write: the service refuses this to the shared
 * service principal outright, because a merge retires a person's record and moves their login.
 * The response carries what the merge could not decide -- fields both records answered
 * differently, where the survivor's answer stands -- so the caller can show it rather than let it
 * pass silently.
 */
export async function mergeLabMembersAsAdmin(
  survivorId: string,
  duplicateId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<
  AuthResult<{
    member: LabMember;
    conflicts: Array<{ field: string; kept: unknown; discarded: unknown }>;
    moved: Record<string, number>;
  }>
> {
  const result = await authedJson(baseUrl, "/lab/members/merge", "POST", sessionToken, {
    survivor_id: survivorId,
    duplicate_id: duplicateId,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as {
      member: LabMember;
      conflicts: Array<{ field: string; kept: unknown; discarded: unknown }>;
      moved: Record<string, number>;
    },
  };
}

// ---------------------------------------------------------------------------
// Profile overview
//
// How far along each member's own record is: the mandatory profile fields they have filled in, and
// whether they have used the Time Availability page to say when they are working. Admin-only; the
// service enforces it, because this is everybody's completeness at once rather than your own.
// ---------------------------------------------------------------------------

export type MemberTimelineCounts = {
  availability: number;
  time_off: number;
  milestones: number;
  trips: number;
  total: number;
};

export type MemberProfileOverviewRow = {
  /**
   * What the lab calls this person: "full", "alumni", "coauthor-major", or a comma-separated
   * combination. The axis the Lab Overview type filter reads; see the service's overview row.
   */
  member_type?: string;
  id: string;
  name: string;
  status?: string;
  privilege_level: string;
  missing_fields: string[];
  filled_field_count: number;
  timeline: MemberTimelineCounts;
  last_reminded_at?: string;
  /**
   * Of `filled_field_count`, how many the member typed themselves rather than an admin or the
   * spreadsheet importer. This is the adoption number: a row can be 12/12 complete and 0/12 adopted.
   */
  self_filled_field_count: number;
  /** Their papers, and how many carry a weekly update they wrote themselves. */
  projects: { total: number; self_updated: number };
  /** Last successful sign-in. Absent means never. */
  last_login_at?: string;
  /** When any hand last wrote to the record. */
  updated_at?: string;
  /** When this member last changed anything themselves. Absent means they never have. */
  last_self_edit_at?: string;
  /**
   * What they have actually done, counted from the audit trail.
   *
   * Distinct from `self_filled_field_count`, which measures how much of the record they wrote. A
   * member can show 0 fields written -- because an importer flattened the provenance -- and still
   * have signed in twenty times. Bounded by the audit retention window, so these are floors.
   *
   * Optional because a server from before this shipped does not send it, and a rolling deploy puts
   * this page in front of one. Absent is rendered as "no recorded activity", which is also what a
   * present-but-empty row means.
   */
  activity?: MemberActivityCounts;
};

export type MemberActivityCounts = {
  logins: number;
  profile_edits: number;
  paper_updates: number;
  last_active_at?: string;
};

/** The lab-wide roll-up, so the page leads with one number instead of asking an admin to add up 77 rows. */
export type MemberAdoptionSummary = {
  members: number;
  /** 0..1, over every mandatory field of every member -- not an average of per-member percentages. */
  profile_rate: number;
  project_rate: number;
  signed_in_ever: number;
  /**
   * Members with any recorded action at all -- signed in, edited themselves, or touched a paper.
   * Optional for the same rolling-deploy reason as MemberProfileOverviewRow.activity.
   */
  active_ever?: number;
};

export type MemberProfileOverview = {
  members: MemberProfileOverviewRow[];
  adoption: MemberAdoptionSummary;
  /**
   * How many fields count toward "complete".
   *
   * Taken from the service rather than counted here: it does not check `name` (a member cannot be
   * created without one), so a client counting the field list itself would show everybody one
   * short forever.
   */
  mandatoryFieldCount: number;
};

export async function fetchMemberProfileOverview(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberProfileOverview>> {
  const result = await authedJson(baseUrl, "/members/profile-overview", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as {
    members?: Array<Partial<MemberProfileOverviewRow>>;
    mandatory_field_count?: number;
    adoption?: MemberAdoptionSummary;
  } | null;
  const members = (body?.members ?? []).map(profileOverviewRow);
  return {
    ok: true,
    value: {
      members,
      mandatoryFieldCount: body?.mandatory_field_count ?? 0,
      // Zeroed rather than optional: the page renders a percentage either way, and an older service
      // that does not send this should read as "nothing adopted yet" rather than blank the card.
      adoption: body?.adoption ?? {
        members: members.length,
        profile_rate: 0,
        project_rate: 0,
        signed_in_ever: 0,
      },
    },
  };
}

/**
 * One row with every counted field present.
 *
 * The service and the Control UI deploy separately here -- the UI ships from Vercel on merge, the
 * service needs a run on the host -- so the browser regularly holds a page newer than the service
 * answering it. `projects` and `timeline` are read unguarded while rendering a row and while
 * filtering, so a service that predates either does not degrade the column: it throws inside the
 * render and the whole page comes up blank. Zeroed here instead, in the same place and for the same
 * reason `adoption` already is, because an absent count means "this service cannot tell us", which
 * on this page reads the same as none.
 *
 * The current service relies on this too: it leaves out each of these when it equals the fill-in
 * here (zero counts, no gaps, the default privilege), so a lab of mostly dormant rows is not a
 * thousand copies of the same zeroes. A change to a fill-in value here is a change to what those
 * rows say.
 */
function profileOverviewRow(row: Partial<MemberProfileOverviewRow>): MemberProfileOverviewRow {
  return {
    ...row,
    id: row.id ?? "",
    name: row.name ?? "",
    privilege_level: row.privilege_level ?? "member",
    missing_fields: row.missing_fields ?? [],
    filled_field_count: row.filled_field_count ?? 0,
    self_filled_field_count: row.self_filled_field_count ?? 0,
    projects: row.projects ?? { total: 0, self_updated: 0 },
    timeline: row.timeline ?? {
      availability: 0,
      time_off: 0,
      milestones: 0,
      trips: 0,
      total: 0,
    },
  };
}

/**
 * Who changed what on one member's record, newest first.
 *
 * Your own, or an admin's read of anyone's. A 404 means the service predates this route -- the
 * Control UI ships on merge and the service is deployed separately, so a new panel can reach a
 * server that has never heard of it.
 */
export async function fetchMemberRecentEdits(
  memberId: string,
  sessionToken: string,
  baseUrl: string,
  limit = 20,
): Promise<AuthResult<RecentUpdateRow[]>> {
  return readRecentUpdates(
    await authedJson(
      baseUrl,
      `/lab/members/${encodeURIComponent(memberId)}/recent-edits?limit=${encodeURIComponent(String(limit))}`,
      "GET",
      sessionToken,
    ),
  );
}

/**
 * One run of sign-ins from a single place. Mirrors AdminBotTravelStay in the service, which is
 * where the collapse from raw logins to stays happens and where the reasoning for it lives.
 */
export type TravelStayRow = {
  id: string;
  city?: string;
  country?: string;
  continent?: string;
  timezone?: string;
  first_seen: string;
  last_seen: string;
  login_count: number;
  observed_days: number;
  away: boolean;
};

/** Mirrors AdminBotTravelHistory. */
export type TravelHistoryRow = {
  member_id: string;
  member_name?: string;
  home_city?: string;
  home_country?: string;
  stays: TravelStayRow[];
  login_count: number;
  unlocated_login_count: number;
};

/**
 * One member's travel timeline, derived from their sign-in log.
 *
 * The range is passed to the service rather than applied here: a stay is a run of consecutive
 * sign-ins, so trimming the log after the collapse would cut a stay in half and report a departure
 * that never happened.
 */
export async function fetchMemberTravelHistory(
  memberId: string,
  sessionToken: string,
  baseUrl: string,
  range?: { fromIso?: string; toIso?: string },
): Promise<AuthResult<TravelHistoryRow | null>> {
  const query = new URLSearchParams();
  if (range?.fromIso) query.set("from", range.fromIso);
  if (range?.toIso) query.set("to", range.toIso);
  const suffix = query.size ? `?${query.toString()}` : "";
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}/travel${suffix}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { travel?: TravelHistoryRow } | null;
  return { ok: true, value: body?.travel ?? null };
}

/**
 * Applies the lab's access design to the nudge list, once.
 *
 * Server-computed like the reminder above: this sends no names. It adds people already marked as
 * full lab members, writes off anybody whose access level has no portal to act on a nudge in, and
 * never overrides a decision an admin has made -- so pressing it twice is the same as pressing it
 * once.
 */
export async function seedNudgeList(
  sessionToken: string,
  baseUrl: string,
  dryRun: boolean,
): Promise<AuthResult<{ added: number; silenced: number; alreadyDecided: number }>> {
  const result = await authedJson(baseUrl, "/members/nudge-list/seed", "POST", sessionToken, {
    dry_run: dryRun,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as
    | { members_added?: number; members_silenced?: number; already_decided?: number }
    | undefined;
  return {
    ok: true,
    value: {
      added: body?.members_added ?? 0,
      silenced: body?.members_silenced ?? 0,
      alreadyDecided: body?.already_decided ?? 0,
    },
  };
}

/** Runs the daily mandatory-fields reminder now. Recipients are server-computed, never ours. */
export async function runMandatoryFieldsReminder(
  sessionToken: string,
  baseUrl: string,
  /**
   * Narrows the sweep to one gap and one set of people -- what the Profile Overview filter is
   * showing. Omitted, the service chases both gaps across everyone owed a reminder, which is what
   * the daily cron does.
   */
  scope?: { include: "profile" | "timeline" | "both"; memberIds: string[] },
): Promise<AuthResult<{ created: number; skipped: number }>> {
  const result = await authedJson(
    baseUrl,
    "/members/mandatory-fields-reminder/run",
    "POST",
    sessionToken,
    {
      ...(scope ? { include: scope.include } : {}),
      ...(scope?.memberIds.length ? { recipient_member_ids: scope.memberIds } : {}),
    },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { created?: unknown[]; skipped?: unknown[] } | null;
  return {
    ok: true,
    value: { created: body?.created?.length ?? 0, skipped: body?.skipped?.length ?? 0 },
  };
}
