import type { AdminBotLabMember } from "../contracts/actions.js";
import { memberIdForRow } from "../workflows/onboarding/onboarding-sweep.js";

/** Creation must never turn into an upsert of someone who happens to have the same name. */
export function newMemberIdentity(
  input: Record<string, unknown>,
  members: readonly AdminBotLabMember[],
  now = new Date(),
) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { error: "A name is required to create a member." };
  const emails = [input.email, input.correspondence_email, input.calendar_email]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    members.some((member) =>
      [member.email, member.correspondence_email, member.calendar_email].some((address) =>
        emails.includes(address?.trim().toLowerCase() ?? ""),
      ),
    )
  ) {
    return { error: "This email is already on the roster. Edit the existing member instead." };
  }
  const requested = typeof input.id === "string" ? input.id.trim() : "";
  const taken = new Set(members.map((member) => member.id));
  if (requested && taken.has(requested))
    return { error: "This member ID already exists. Leave it blank to generate a unique ID." };
  const base = requested || memberIdForRow(name) || "member";
  let id = base;
  for (let suffix = 0; taken.has(id); suffix++) {
    id = `${base}-${now.getUTCFullYear()}${suffix ? `-${suffix + 1}` : ""}`;
  }
  return { id };
}
