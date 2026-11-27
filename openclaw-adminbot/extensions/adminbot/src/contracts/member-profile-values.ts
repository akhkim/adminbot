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
/**
 * Languages a member can annotate data in: read and write well enough to judge model output or
 * label text in it. A closed list, so a search for Hindi annotators finds every one of them rather
 * than the ones who happened to spell it the same way. Alphabetical; no entry contains a comma,
 * which is what lets the answers share one comma-joined string (see formatAdminBotMultiAnswer).
 * Add a language here rather than accepting free text.
 */
export const ANNOTATION_LANGUAGE_OPTIONS = [
  "Afrikaans",
  "Amharic",
  "Arabic",
  "Basque",
  "Bengali",
  "Bulgarian",
  "Burmese",
  "Cantonese",
  "Catalan",
  "Croatian",
  "Czech",
  "Danish",
  "Dutch",
  "English",
  "Estonian",
  "Filipino (Tagalog)",
  "Finnish",
  "French",
  "German",
  "Greek",
  "Gujarati",
  "Hausa",
  "Hebrew",
  "Hindi",
  "Hungarian",
  "Igbo",
  "Indonesian",
  "Italian",
  "Japanese",
  "Kannada",
  "Kazakh",
  "Korean",
  "Latvian",
  "Lithuanian",
  "Malay",
  "Malayalam",
  "Mandarin Chinese",
  "Marathi",
  "Nepali",
  "Norwegian",
  "Persian (Farsi)",
  "Polish",
  "Portuguese",
  "Punjabi",
  "Romanian",
  "Russian",
  "Serbian",
  "Sinhala",
  "Slovak",
  "Slovenian",
  "Spanish",
  "Swahili",
  "Swedish",
  "Tamil",
  "Telugu",
  "Thai",
  "Turkish",
  "Ukrainian",
  "Urdu",
  "Vietnamese",
  "Yoruba",
  "Zulu",
] as const;

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
