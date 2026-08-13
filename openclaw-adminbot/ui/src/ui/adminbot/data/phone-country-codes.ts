// Country calling codes for the phone controls on the profile page.
//
// A member types the local part of their number and picks the country, rather than typing a "+"
// prefix nobody remembers the shape of. The stored value stays one free-text string ("+1 555
// 0100") -- the roster column is a phone number, not a pair of fields -- so this list only has to
// cover picking and re-splitting a prefix, never validating the number itself.
//
// `dial` carries the leading "+". Several codes are shared (+1 by the US, Canada and the Caribbean;
// +7 by Russia and Kazakhstan), so a stored prefix maps back to whichever entry lists it first --
// which is why the most populous holder of a shared code is listed above the others.
export type PhoneCountry = {
  name: string;
  iso: string;
  dial: string;
};

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { name: "United States", iso: "US", dial: "+1" },
  { name: "Canada", iso: "CA", dial: "+1" },
  { name: "Afghanistan", iso: "AF", dial: "+93" },
  { name: "Albania", iso: "AL", dial: "+355" },
  { name: "Algeria", iso: "DZ", dial: "+213" },
  { name: "Argentina", iso: "AR", dial: "+54" },
  { name: "Armenia", iso: "AM", dial: "+374" },
  { name: "Australia", iso: "AU", dial: "+61" },
  { name: "Austria", iso: "AT", dial: "+43" },
  { name: "Azerbaijan", iso: "AZ", dial: "+994" },
  { name: "Bahrain", iso: "BH", dial: "+973" },
  { name: "Bangladesh", iso: "BD", dial: "+880" },
  { name: "Belarus", iso: "BY", dial: "+375" },
  { name: "Belgium", iso: "BE", dial: "+32" },
  { name: "Bolivia", iso: "BO", dial: "+591" },
  { name: "Bosnia and Herzegovina", iso: "BA", dial: "+387" },
  { name: "Brazil", iso: "BR", dial: "+55" },
  { name: "Bulgaria", iso: "BG", dial: "+359" },
  { name: "Cambodia", iso: "KH", dial: "+855" },
  { name: "Cameroon", iso: "CM", dial: "+237" },
  { name: "Chile", iso: "CL", dial: "+56" },
  { name: "China", iso: "CN", dial: "+86" },
  { name: "Colombia", iso: "CO", dial: "+57" },
  { name: "Costa Rica", iso: "CR", dial: "+506" },
  { name: "Croatia", iso: "HR", dial: "+385" },
  { name: "Cuba", iso: "CU", dial: "+53" },
  { name: "Cyprus", iso: "CY", dial: "+357" },
  { name: "Czechia", iso: "CZ", dial: "+420" },
  { name: "Denmark", iso: "DK", dial: "+45" },
  { name: "Dominican Republic", iso: "DO", dial: "+1809" },
  { name: "Ecuador", iso: "EC", dial: "+593" },
  { name: "Egypt", iso: "EG", dial: "+20" },
  { name: "Estonia", iso: "EE", dial: "+372" },
  { name: "Ethiopia", iso: "ET", dial: "+251" },
  { name: "Finland", iso: "FI", dial: "+358" },
  { name: "France", iso: "FR", dial: "+33" },
  { name: "Georgia", iso: "GE", dial: "+995" },
  { name: "Germany", iso: "DE", dial: "+49" },
  { name: "Ghana", iso: "GH", dial: "+233" },
  { name: "Greece", iso: "GR", dial: "+30" },
  { name: "Guatemala", iso: "GT", dial: "+502" },
  { name: "Hong Kong", iso: "HK", dial: "+852" },
  { name: "Hungary", iso: "HU", dial: "+36" },
  { name: "Iceland", iso: "IS", dial: "+354" },
  { name: "India", iso: "IN", dial: "+91" },
  { name: "Indonesia", iso: "ID", dial: "+62" },
  { name: "Iran", iso: "IR", dial: "+98" },
  { name: "Iraq", iso: "IQ", dial: "+964" },
  { name: "Ireland", iso: "IE", dial: "+353" },
  { name: "Israel", iso: "IL", dial: "+972" },
  { name: "Italy", iso: "IT", dial: "+39" },
  { name: "Jamaica", iso: "JM", dial: "+1876" },
  { name: "Japan", iso: "JP", dial: "+81" },
  { name: "Jordan", iso: "JO", dial: "+962" },
  { name: "Kazakhstan", iso: "KZ", dial: "+7" },
  { name: "Kenya", iso: "KE", dial: "+254" },
  { name: "Kuwait", iso: "KW", dial: "+965" },
  { name: "Latvia", iso: "LV", dial: "+371" },
  { name: "Lebanon", iso: "LB", dial: "+961" },
  { name: "Lithuania", iso: "LT", dial: "+370" },
  { name: "Luxembourg", iso: "LU", dial: "+352" },
  { name: "Malaysia", iso: "MY", dial: "+60" },
  { name: "Malta", iso: "MT", dial: "+356" },
  { name: "Mexico", iso: "MX", dial: "+52" },
  { name: "Moldova", iso: "MD", dial: "+373" },
  { name: "Mongolia", iso: "MN", dial: "+976" },
  { name: "Morocco", iso: "MA", dial: "+212" },
  { name: "Nepal", iso: "NP", dial: "+977" },
  { name: "Netherlands", iso: "NL", dial: "+31" },
  { name: "New Zealand", iso: "NZ", dial: "+64" },
  { name: "Nigeria", iso: "NG", dial: "+234" },
  { name: "North Macedonia", iso: "MK", dial: "+389" },
  { name: "Norway", iso: "NO", dial: "+47" },
  { name: "Oman", iso: "OM", dial: "+968" },
  { name: "Pakistan", iso: "PK", dial: "+92" },
  { name: "Palestine", iso: "PS", dial: "+970" },
  { name: "Panama", iso: "PA", dial: "+507" },
  { name: "Peru", iso: "PE", dial: "+51" },
  { name: "Philippines", iso: "PH", dial: "+63" },
  { name: "Poland", iso: "PL", dial: "+48" },
  { name: "Portugal", iso: "PT", dial: "+351" },
  { name: "Qatar", iso: "QA", dial: "+974" },
  { name: "Romania", iso: "RO", dial: "+40" },
  { name: "Russia", iso: "RU", dial: "+7" },
  { name: "Saudi Arabia", iso: "SA", dial: "+966" },
  { name: "Senegal", iso: "SN", dial: "+221" },
  { name: "Serbia", iso: "RS", dial: "+381" },
  { name: "Singapore", iso: "SG", dial: "+65" },
  { name: "Slovakia", iso: "SK", dial: "+421" },
  { name: "Slovenia", iso: "SI", dial: "+386" },
  { name: "South Africa", iso: "ZA", dial: "+27" },
  { name: "South Korea", iso: "KR", dial: "+82" },
  { name: "Spain", iso: "ES", dial: "+34" },
  { name: "Sri Lanka", iso: "LK", dial: "+94" },
  { name: "Sweden", iso: "SE", dial: "+46" },
  { name: "Switzerland", iso: "CH", dial: "+41" },
  { name: "Taiwan", iso: "TW", dial: "+886" },
  { name: "Tanzania", iso: "TZ", dial: "+255" },
  { name: "Thailand", iso: "TH", dial: "+66" },
  { name: "Tunisia", iso: "TN", dial: "+216" },
  { name: "Turkey", iso: "TR", dial: "+90" },
  { name: "Uganda", iso: "UG", dial: "+256" },
  { name: "Ukraine", iso: "UA", dial: "+380" },
  { name: "United Arab Emirates", iso: "AE", dial: "+971" },
  { name: "United Kingdom", iso: "GB", dial: "+44" },
  { name: "Uruguay", iso: "UY", dial: "+598" },
  { name: "Uzbekistan", iso: "UZ", dial: "+998" },
  { name: "Venezuela", iso: "VE", dial: "+58" },
  { name: "Vietnam", iso: "VN", dial: "+84" },
  { name: "Zambia", iso: "ZM", dial: "+260" },
  { name: "Zimbabwe", iso: "ZW", dial: "+263" },
];

/**
 * Splits a stored phone number into the country code it starts with and the rest.
 *
 * Longest prefix wins, so "+1876 555 0100" resolves to Jamaica rather than to the United States.
 * A number stored without a recognised prefix keeps its whole text as the local part, which is
 * what preserves the free-text values already on the roster.
 */
export function splitPhoneNumber(value: string): { dial: string; local: string } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("+") && !trimmed.startsWith("(+")) {
    return { dial: "", local: trimmed };
  }
  // Tolerates the "(+1) 555 0100" shape the field's own example used to suggest.
  const normalized = trimmed.replace(/^\((\+[^)]*)\)/, "$1");
  const digitsOnly = normalized.replace(/[^\d+]/g, "");
  const match = [...PHONE_COUNTRIES]
    .map((country) => country.dial)
    .filter((dial) => digitsOnly.startsWith(dial))
    .toSorted((left, right) => right.length - left.length)[0];
  if (!match) {
    return { dial: "", local: trimmed };
  }
  return { dial: match, local: normalized.slice(match.length).trim() };
}

/** Joins a picked country code and a typed local number back into the stored single string. */
export function joinPhoneNumber(dial: string, local: string): string {
  const number = local.trim();
  if (!number) {
    return "";
  }
  return dial ? `${dial} ${number}` : number;
}

/** What the country picker displays for a country: the code first, then the name to search by. */
export function phoneCountryLabel(country: PhoneCountry): string {
  return `${country.dial} ${country.name}`;
}

/**
 * Resolves whatever is in the country box back to a dial code.
 *
 * The control is a text input with a suggestion list rather than a `<select>`, so that a member
 * can find their country by typing its name -- a native select only type-ahead-matches from the
 * start of the option text, which here is the dial code. That freedom means the box can hold
 * anything, so this accepts the three things a person plausibly leaves in it: a full suggestion
 * ("+44 United Kingdom"), a bare code ("+44", with or without the plus), or a country name typed
 * without picking from the list ("united kingdom"). Anything else resolves to no code, and the
 * number is stored exactly as typed.
 */
export function resolvePhoneDial(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const byLabel = PHONE_COUNTRIES.find(
    (country) => phoneCountryLabel(country).toLowerCase() === trimmed.toLowerCase(),
  );
  if (byLabel) {
    return byLabel.dial;
  }
  const dialCandidate = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  if (PHONE_COUNTRIES.some((country) => country.dial === dialCandidate)) {
    return dialCandidate;
  }
  const byName = PHONE_COUNTRIES.find(
    (country) => country.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return byName?.dial ?? "";
}
