// Member-facing reminder copy, moved out of kernel/service.ts (a grandfathered file) unchanged.
// service.ts re-exports these so existing imports keep working.

/**
 * The onboarding ladder's two Slack reminders.
 *
 * The second says it is the second. A follow-up that reads identically to the message three days
 * before it is how somebody learns the sender is not keeping track, and the point of naming it is
 * that the *next* thing that happens is a person -- which the second message says out loud, so the
 * escalation is never a surprise.
 *
 * Neither message asks for anything the welcome did not already ask for. It names the one action
 * that clears it (sign in), because a reminder that re-explains onboarding is a second onboarding
 * email nobody asked for.
 */
export function buildOnboardingFollowUpMessage(params: {
  step: "first_reminder" | "second_reminder";
  /**
   * Days since the onboarding email, when the trail records when it went out.
   *
   * Absent for the already-emailed backlog, whose sends predate the audit trail. The alternative
   * was to derive a number from `created_at`, which would have produced "your onboarding email
   * went out 400 days ago" -- the exact accusation buildDormantAccountMessage exists to avoid. A
   * sentence that does not claim a date is better than one that claims a wrong one.
   */
  days?: number;
}): string {
  if (params.step === "first_reminder") {
    return [
      params.days === undefined
        ? "Your onboarding email has gone out and the portal has not seen you yet."
        : `Your onboarding email went out ${params.days} days ago and the portal has not seen you yet.`,
      "",
      "Signing in once is all this needs — it is what unlocks your profile, your papers and the calendar.",
    ].join("\n");
  }
  return [
    params.days === undefined
      ? "Still nothing on your account since your onboarding email — this is the second reminder."
      : `Still nothing on your account ${params.days} days after your onboarding email — this is the second reminder.`,
    "",
    "Signing in once clears it. If something is in the way (no access, wrong address, wrong person), say so here and I will sort it out rather than keep asking.",
  ].join("\n");
}

/**
 * The standing reminder for an account nobody has ever opened.
 *
 * Deliberately not the onboarding copy. This one goes to people whose welcome was months ago, and
 * a message saying "your onboarding email went out 90 days ago" reads as an accusation rather than
 * as an offer.
 */
export function buildDormantAccountMessage(): string {
  return [
    "Your AdminBot account is set up but has never been signed into.",
    "",
    "One sign-in is all it takes, and it is what puts your profile, papers and deadlines in front of you. If you cannot get in, reply here.",
  ].join("\n");
}

export function buildNudgeEscalationMessage(params: {
  memberName: string;
  professorName: string;
  outstanding: readonly string[];
  days: number;
}): string {
  const first = params.memberName.trim().split(/\s+/u)[0] || params.memberName;
  const list = params.outstanding.map((title) => `• ${title}`).join("\n");
  return [
    // Says where it has gone rather than pretending the professor is reading this thread. They are
    // not in the DM any more -- it is on their page -- and a message claiming an audience that is
    // not here is the kind of small lie that makes the rest of the sentence untrustworthy.
    `Hi ${first} — these have been outstanding for ${params.days} days, so they are now on ${params.professorName}'s list:`,
    "",
    list,
    "",
    "If any of them are already done or no longer apply, say so here and I will close them out.",
  ].join("\n");
}
