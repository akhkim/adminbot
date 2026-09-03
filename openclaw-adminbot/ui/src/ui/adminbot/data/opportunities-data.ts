// Opportunities the lab wants members to hear about: PhD programs, internships, grants and
// awards, and Rising Stars workshops.
//
// Hand-maintained, unlike `deadlines-data.ts` which is generated from venues.json. These are
// annual programs whose dates are announced by the host institution rather than scraped, so an
// admin edits this file and the Opportunities tab picks it up on the next UI build.
//
// `deadline_aoe` is empty when the cycle's date has not been announced. The view renders those as
// "Deadline TBA" and sorts them after everything dated -- an unannounced deadline must never
// render as if it were a real one, because members plan around this tab.

export const OPPORTUNITY_CATEGORIES = [
  "phd",
  "internship",
  "grants_awards",
  "rising_stars",
  "faculty",
] as const;

export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

export const OPPORTUNITY_CATEGORY_LABELS: Record<OpportunityCategory, string> = {
  phd: "PhD",
  internship: "Internships",
  grants_awards: "Grants & Awards",
  rising_stars: "Rising Stars",
  faculty: "Faculty Job Market",
};

export const OPPORTUNITY_STATUSES = ["pending", "approved", "rejected"] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export type Opportunity = {
  id: string;
  name: string;
  category: OpportunityCategory;
  // Host institution, funder, or organising body.
  org?: string;
  // AoE wall clock, "YYYY-MM-DD HH:MM:SS". Empty means the date is not yet announced.
  deadline_aoe: string;
  link?: string;
  // Who the program is for, in the program's own framing. Shown verbatim so members can judge
  // their own eligibility rather than having the lab decide it for them.
  eligibility?: string;
  note?: string;
  // Free-text application window, e.g. "Sep 1 – Oct 15, 2026".
  application_window?: string;
};

/**
 * An entry a member suggested, as the service returns it.
 *
 * The bundled list above is lab-vetted and ships with the build; these arrive at runtime and carry
 * the review state that decides who may see them. `status` is present here and absent on a bundled
 * `Opportunity`, which is what the board keys "can this be edited" off -- a bundled row has no
 * server-side identity to edit.
 */
export type AdminBotOpportunityView = Opportunity & {
  status: OpportunityStatus;
  submitted_by_member_id?: string;
  submitted_by_name?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: string;
};

/** What the add/edit form sends. The service re-validates all of it. */
export type AdminBotOpportunityDraft = {
  name: string;
  category: OpportunityCategory;
  org?: string;
  deadline_aoe?: string;
  link?: string;
  eligibility?: string;
  note?: string;
  application_window?: string;
};

export function isContributedOpportunity(
  entry: Opportunity | AdminBotOpportunityView,
): entry is AdminBotOpportunityView {
  return "status" in entry;
}

export const OPPORTUNITIES: Opportunity[] = [
  // --- Rising Stars ---------------------------------------------------------------------
  // These workshops rotate host institution each year, so both the URL and the deadline change
  // annually. Left undated deliberately: an admin fills in each cycle's date and link once the
  // host announces them. See docs/tools/adminbot-opportunities.md.
  {
    id: "rising_stars_eecs",
    name: "Rising Stars in EECS",
    category: "rising_stars",
    org: "Rotating host (MIT, Berkeley, UT Austin, and others)",
    deadline_aoe: "",
    eligibility:
      "Women and gender minorities in electrical engineering and computer science who are " +
      "interested in academic careers; typically senior PhD students and postdocs.",
    note: "Host institution and application window change each year.",
  },
  {
    id: "rising_stars_ml",
    name: "Rising Stars in Machine Learning",
    category: "rising_stars",
    org: "Rotating host",
    deadline_aoe: "",
    eligibility:
      "Women and underrepresented groups in machine learning, at the senior PhD or postdoc " +
      "stage, considering faculty positions.",
    note: "Host institution and application window change each year.",
  },
  {
    id: "rising_stars_data_science",
    name: "Rising Stars in Data Science",
    category: "rising_stars",
    org: "Rotating host",
    deadline_aoe: "",
    eligibility:
      "Women and researchers from underrepresented groups working in data science who are " +
      "approaching the academic job market.",
    note: "Host institution and application window change each year.",
  },
];
