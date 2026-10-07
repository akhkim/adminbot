// The admin editor's Change ID button. Changing the id is its own route, never the member upsert,
// which would fork the record: the upsert is an id-keyed merge.
import { html, nothing } from "lit";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import { cancelMemberAutosave } from "../member-autosave.ts";

export type RenameMember = (memberId: string, newId: string) => void;

export function renderChangeMemberIdButton(
  member: AdminBotLabMember | undefined,
  onRenameMember: RenameMember | undefined,
) {
  return member && onRenameMember
    ? html`<button
        class="btn btn--sm"
        type="button"
        data-testid="member-change-id"
        @click=${(event: Event) => changeMemberId(event, member, onRenameMember)}
      >
        Change ID
      </button>`
    : nothing;
}

function changeMemberId(event: Event, member: AdminBotLabMember, onRenameMember: RenameMember) {
  const newId = globalThis.prompt?.(`New member ID for ${member.name}:`, member.id)?.trim();
  if (!newId || newId === member.id) {
    return;
  }
  if (
    !globalThis.confirm?.(
      `Change ${member.name}'s member ID from "${member.id}" to "${newId}"?\n\n` +
        `Their papers, sign-in, sessions and settings move to the new ID. ` +
        `Links that spell out the old ID stop working.`,
    )
  ) {
    return;
  }
  // A queued autosave carries the old id, and landing after the rename would upsert a fresh record
  // under it -- a ghost of the member just moved. Drop it; the roster reloads after the rename.
  const form = (event.currentTarget as Element | null)?.closest("form");
  if (form) {
    cancelMemberAutosave(form);
    form.closest<HTMLElement>("[popover]")?.hidePopover();
  }
  onRenameMember(member.id, newId);
}
