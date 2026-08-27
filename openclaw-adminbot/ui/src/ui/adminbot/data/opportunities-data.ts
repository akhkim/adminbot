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
};

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
