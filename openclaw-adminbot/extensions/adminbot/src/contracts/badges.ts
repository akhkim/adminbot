export const ADMINBOT_BADGE_DESCRIPTION_MAX = 240;
export const ADMINBOT_BADGE_EVIDENCE_MAX = 2000;
export const ADMINBOT_BADGE_CATEGORY_MAX = 80;

export const adminBotBadgeAssignmentSources = ["admin", "nomination"] as const;

export type AdminBotBadgeAssignmentSource = (typeof adminBotBadgeAssignmentSources)[number];

export type AdminBotBadgeDefinitionInput = {
  id?: string;
  category: string;
  name: string;
  description: string;
  criteria_url?: string;
  tier?: string;
  family_key?: string;
  sort_order?: number;
};

export type AdminBotBadgeDefinition = Omit<
  Required<Pick<AdminBotBadgeDefinitionInput, "id" | "category" | "name" | "description">>,
  never
> &
  Pick<AdminBotBadgeDefinitionInput, "criteria_url" | "tier"> & {
    family_key: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  };

export type AdminBotBadgeAssignment = {
  member_id: string;
  badge_id: string;
  family_key: string;
  awarded_at: string;
  awarded_by: string;
  source: AdminBotBadgeAssignmentSource;
  nomination_id?: string;
  evidence?: string;
};

export type AdminBotAssignedBadge = AdminBotBadgeAssignment & {
  category: string;
  name: string;
  description: string;
  criteria_url?: string;
  tier?: string;
  sort_order: number;
};

export const adminBotBadgeNominationStatuses = ["pending", "approved", "rejected"] as const;

export type AdminBotBadgeNominationStatus = (typeof adminBotBadgeNominationStatuses)[number];

export type AdminBotBadgeNomination = {
  id: string;
  badge_id: string;
  family_key: string;
  member_id: string;
  evidence?: string;
  status: AdminBotBadgeNominationStatus;
  created_at: string;
  decided_at?: string;
  decided_by?: string;
};

export type AdminBotBadgeNominationView = AdminBotBadgeNomination & {
  badge_category: string;
  badge_name: string;
  badge_description: string;
  badge_tier?: string;
  badge_criteria_url?: string;
  member_name?: string;
};

export function normalizeBadgeFamilyKey(category: string, name: string): string {
  const base = `${category} ${name}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return base || "badge";
}

export const adminBotDefaultBadgeDefinitions: readonly (AdminBotBadgeDefinitionInput & {
  id: string;
})[] = [
  {
    id: "team_contributor__infra_builder",
    category: "Team Contributor",
    name: "Infra Builder",
    description:
      "Built or maintains shared lab infrastructure (eval pipelines, compute tooling, website, etc.).",
    sort_order: 10,
  },
  {
    id: "team_contributor__bug_hunter",
    category: "Team Contributor",
    name: "Bug Hunter",
    description: "Found a substantive error in a lab paper before submission.",
    sort_order: 20,
  },
  {
    id: "community_building__referral_bonus",
    category: "Community Building",
    name: "Referral Bonus",
    description:
      "At least one person recommended by the user joined the lab for at least one coauthored project.",
    sort_order: 30,
  },
  {
    id: "community_building__ambassador",
    category: "Community Building",
    name: "Ambassador",
    description:
      "Represented or organized lab outreach at a conference booth, outreach event, etc.",
    sort_order: 40,
  },
  {
    id: "community_building__media_impact",
    category: "Community Building",
    name: "Media Impact",
    description:
      "Research was covered by press or cited in a policy or industry document.",
    sort_order: 50,
  },
  {
    id: "causality__level_1",
    category: "Causality",
    name: "Causality",
    tier: "Level 1",
    family_key: "causality",
    description: "Passed the CausalTutor curriculum.",
    sort_order: 60,
  },
  {
    id: "causality__level_2",
    category: "Causality",
    name: "Causality",
    tier: "Level 2",
    family_key: "causality",
    description: "Causal researcher with at least one main-conference publication.",
    sort_order: 70,
  },
  {
    id: "causality__level_3",
    category: "Causality",
    name: "Causality",
    tier: "Level 3",
    family_key: "causality",
    description: "Causal expert with >=3 causality papers.",
    sort_order: 80,
  },
] as const;
