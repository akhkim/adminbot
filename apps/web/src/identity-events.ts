import type { SessionView } from "@adminbot/api-contracts";

export const SESSION_CHANGED_EVENT = "adminbot-session-changed";

export type SessionChangedDetail = Readonly<{ session: SessionView | undefined }>;

export function sessionChangedEvent(session: SessionView | undefined): CustomEvent<SessionChangedDetail> {
  return new CustomEvent(SESSION_CHANGED_EVENT, {
    detail: { session },
    bubbles: true,
    composed: true,
  });
}
