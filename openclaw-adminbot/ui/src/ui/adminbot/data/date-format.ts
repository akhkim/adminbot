/**
 * A shared `Intl.DateTimeFormat` for each locale and options.
 *
 * Constructing one costs ~15x formatting with one, and the deadline board formats several labels
 * per row on a one-second tick. Keys are call-site literals times the zones in use, so the cache
 * stays small; the cap only guards against a caller passing something unbounded.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(
  locale: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= 500) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}
