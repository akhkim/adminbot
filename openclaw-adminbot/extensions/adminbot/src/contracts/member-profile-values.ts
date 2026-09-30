// Exact aliases only: never guess an unfamiliar person's city or institution.
export const MEMBER_CITY_OPTIONS = ["Zurich", "Tübingen", "Toronto"] as const;
export const MEMBER_AFFILIATION_OPTIONS = [
  "ETH Zurich",
  "University of Tübingen",
  "University of Toronto",
  "Oregon State University",
] as const;
const aliases: Record<string, Record<string, string>> = {
  location: {
    zurich: "Zurich",
    zürich: "Zurich",
    tubingen: "Tübingen",
    tuebingen: "Tübingen",
    tübingen: "Tübingen",
    toronto: "Toronto",
    "toronto, on": "Toronto",
  },
  affiliation: {
    eth: "ETH Zurich",
    "eth zurich": "ETH Zurich",
    "eth zürich": "ETH Zurich",
    "u toronto": "University of Toronto",
    "u of t": "University of Toronto",
    uoft: "University of Toronto",
    "university of toronto": "University of Toronto",
    "university of tubingen": "University of Tübingen",
    "university of tuebingen": "University of Tübingen",
    "university of tübingen": "University of Tübingen",
  },
};
export function normalizeMemberProfileValues<T extends object>(input: T): T {
  const normalized = { ...input };
  const fields = normalized as Record<string, unknown>;
  for (const field of ["location", "affiliation"] as const) {
    const value = fields[field];
    if (typeof value === "string") {
      const key = value.trim().toLowerCase();
      fields[field] = Object.hasOwn(aliases[field]!, key) ? aliases[field]![key] : value;
    }
  }
  return normalized;
}
