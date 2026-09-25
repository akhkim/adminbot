import type { MemberTypeChangeSummary } from "../auth/session.ts";

const STEP_LABEL: Record<MemberTypeChangeSummary["steps"][number]["step"], string> = {
  meeting: "meeting",
  sheet: "member sheet",
  slack: "Slack",
  group_meeting: "Monday meeting",
  lab_calendar: "lab calendar",
  alumni_mail: "alumni email",
};

function describeStep(step: MemberTypeChangeSummary["steps"][number]): string {
  const label = STEP_LABEL[step.step];
  const target = step.target ? ` ${step.target}` : "";
  return step.detail ? `${label}${target} (${step.detail})` : `${label}${target}`;
}

/**
 * The save notice for a Member Type or Meetings change: what moved, what was done, what was not.
 *
 * An error notice when any step failed, because the database now says one thing and the failed
 * system another -- the admin needs to know which, not just that the save went through. Skipped
 * steps are listed but do not turn it red: "no linked Slack account" is an answer, not a fault.
 */
export function describeMemberTypeChange(
  memberId: string,
  change: MemberTypeChangeSummary | undefined,
  meetingSteps: MemberTypeChangeSummary["steps"] = [],
): { kind: "success" | "error"; text: string } {
  const parts = [`Saved ${memberId}.`];
  if (change) {
    parts[0] = `Saved ${memberId}: member type ${change.from?.trim() || "unset"} → ${
      change.to?.trim() || "unset"
    }.`;
    if (change.privilege_level.from !== change.privilege_level.to) {
      parts.push(`Access level ${change.privilege_level.from} → ${change.privilege_level.to}.`);
    }
  }
  const steps = [...(change?.steps ?? []), ...meetingSteps];
  const done = steps.filter((step) => step.status === "done");
  const skipped = steps.filter((step) => step.status === "skipped");
  const failed = steps.filter((step) => step.status === "failed");
  if (done.length > 0) {
    parts.push(`Done: ${done.map(describeStep).join("; ")}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.map(describeStep).join("; ")}.`);
  }
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.map(describeStep).join("; ")}.`);
  }
  return { kind: failed.length > 0 ? "error" : "success", text: parts.join(" ") };
}
