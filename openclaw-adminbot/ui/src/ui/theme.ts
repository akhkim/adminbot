// Control UI module implements theme behavior.
// Dark-only: the "knot"/"dash" theme families and light mode are removed (design spec §2).
// ThemeMode is kept as a type (callers across the app still pass/store it) but no longer
// changes the resolved palette — every mode resolves to "dark".
export type ThemeName = "claw" | "custom";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "dark" | "custom";

export const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "custom"]);
const VALID_THEME_MODES = new Set<ThemeMode>(["system", "light", "dark"]);

type ThemeSelection = { theme: ThemeName; mode: ThemeMode };

// Every theme/mode value a user may still have persisted from earlier product names and
// the removed "knot"/"dash" families. All of them normalize to the single dark theme now —
// legacy stored settings must resolve, never throw.
const LEGACY_MAP: Record<string, ThemeSelection> = {
  defaultTheme: { theme: "claw", mode: "dark" },
  docsTheme: { theme: "claw", mode: "dark" },
  lightTheme: { theme: "claw", mode: "dark" },
  landingTheme: { theme: "claw", mode: "dark" },
  newTheme: { theme: "claw", mode: "dark" },
  dark: { theme: "claw", mode: "dark" },
  light: { theme: "claw", mode: "dark" },
  openknot: { theme: "claw", mode: "dark" },
  fieldmanual: { theme: "claw", mode: "dark" },
  clawdash: { theme: "claw", mode: "dark" },
  system: { theme: "claw", mode: "dark" },
  knot: { theme: "claw", mode: "dark" },
  dash: { theme: "claw", mode: "dark" },
};

/** Dark-only: there is no system-preference palette to mirror anymore. */
export function resolveSystemTheme(): ResolvedTheme {
  return "dark";
}

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  const theme = typeof themeRaw === "string" ? themeRaw : "";
  const mode = typeof modeRaw === "string" ? modeRaw : "";

  const normalizedTheme = VALID_THEME_NAMES.has(theme as ThemeName)
    ? (theme as ThemeName)
    : (LEGACY_MAP[theme]?.theme ?? "claw");
  const normalizedMode = VALID_THEME_MODES.has(mode as ThemeMode)
    ? (mode as ThemeMode)
    : (LEGACY_MAP[theme]?.mode ?? "dark");

  return { theme: normalizedTheme, mode: normalizedMode };
}

/**
 * `mode` is retained in the signature only because callers across the app (e.g.
 * app-settings.ts's system-preference listener) still pass it. It no longer affects the
 * result: dark-only means every mode resolves to the same palette.
 */
export function resolveTheme(theme: ThemeName, _mode: ThemeMode): ResolvedTheme {
  return theme === "custom" ? "custom" : "dark";
}
