/**
 * Shared chat text normalization.
 *
 * Blank and whitespace-only strings must collapse to undefined rather than "", so
 * that an absent field and an empty one are indistinguishable to every downstream
 * chat subhandler. Kept in its own module so the subhandler fragments and the
 * handler table can share it without importing each other.
 */

export function normalizeUnknownText(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalText(value) : undefined;
}

export function normalizeOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
