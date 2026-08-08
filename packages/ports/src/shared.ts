export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface RegistrationProfileRecord {
  readonly displayName: string;
  readonly slackUserId?: string;
  readonly role?: string;
  readonly affiliation?: string;
  readonly researchBranch?: string;
  readonly researchTopics?: readonly string[];
  readonly projects?: readonly string[];
  readonly hoursPerWeek?: number;
  readonly location?: string;
  readonly timezone?: string;
  readonly personalWebsite?: string;
  readonly notes?: string;
}
