// A custom domain is not proof of institutional ownership. This check only detects known
// consumer mail providers; it does not query DNS or send verification mail.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.ca",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "mail.com",
  "gmx.com",
  "gmx.net",
]);

export function adminBotIsPersonalCorrespondenceEmail(value: string): boolean {
  const domain = value.trim().toLowerCase().split("@").at(-1);
  return domain !== undefined && PERSONAL_EMAIL_DOMAINS.has(domain);
}
