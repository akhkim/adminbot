// English strings for the account-request queue, used by en.ts as `adminbotRegistrations`.
// Its own module so en.ts stays under its file-size ratchet; the i18n tooling reads the composed
// `en` map, so where a section is written does not change what gets translated.
import type { TranslationMap } from "../lib/types.ts";

export const enAdminbotRegistrations: TranslationMap = {
  title: "Member requests",
  sub: "Pending account requests awaiting the PI's decision.",
  piOnly: "Only the PI can approve or reject a new member.",
  loading: "Loading member requests…",
  refresh: "Refresh",
  retry: "Retry",
  approve: "Approve",
  reject: "Reject",
  approved: "Request approved.",
  rejected: "Request rejected.",
  submitted: "Submitted",
  rosterMember: "Roster member",
  unnamedApplicant: "Unnamed applicant",
  kind: {
    claim: "Roster claim",
    signup: "New signup",
  },
  empty: {
    title: "No member requests to review",
    none: "No pending registrations.",
    noSession: "Sign in with your member email and password to review member requests.",
    expired: "Your session has expired. Sign in again with the member login to continue.",
    forbidden: "Only admins and core members can review member requests.",
    unreachable: "The AdminBot service is unreachable. Check that it's running, then retry.",
    failed: "Couldn't load member requests. Retry in a moment.",
  },
  error: {
    unreachable: "The AdminBot service is unreachable. Check that it's running and try again.",
    forbidden: "Only admins and core members can approve or reject member requests.",
    decisionFailed: "Couldn't record that decision. Refresh the queue and try again.",
  },
  field: {
    memberId: "Member ID",
    affiliation: "Affiliation",
    researchBranch: "Research branch",
    researchTopics: "Research topics",
    location: "Location",
    timezone: "Timezone",
    website: "Personal website",
    notes: "Notes",
  },
};
