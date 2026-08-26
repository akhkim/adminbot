// Control UI module implements theme behavior.
//
// Two palettes and a custom escape hatch. The "knot"/"dash" theme families are still gone (design
// spec §2); what came back is light, because a portal people open in a bright room all day is not
// a terminal.
//
// `theme` is which palette family ("claw", or the tweakcn "custom" override), and `mode` is which
// variant of it the viewer wants. They are separate because "follow my system" is an answer to the
// second question and not to the first.
export type ThemeName = "claw" | "custom";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "dark" | "light" | "custom";

export const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "custom"]);
const VALID_THEME_MODES = new Set<ThemeMode>(["system", "light", "dark"]);

type ThemeSelection = { theme: ThemeName; mode: ThemeMode };

// Every theme/mode value a user may still have persisted from earlier product names and the removed
// "knot"/"dash" families. Stored settings must resolve, never throw.
//
// The three that named a light theme now map to `mode: "light"` rather than being flattened to
// dark. Somebody who chose light before it was removed gets it back rather than being told once
// more that their preference does not exist.
const LEGACY_MAP: Record<string, ThemeSelection> = {
  defaultTheme: { theme: "claw", mode: "dark" },
  docsTheme: { theme: "claw", mode: "light" },
  lightTheme: { theme: "claw", mode: "light" },
  landingTheme: { theme: "claw", mode: "dark" },
  newTheme: { theme: "claw", mode: "dark" },
  dark: { theme: "claw", mode: "dark" },
  light: { theme: "claw", mode: "light" },
  openknot: { theme: "claw", mode: "dark" },
  fieldmanual: { theme: "claw", mode: "dark" },
  clawdash: { theme: "claw", mode: "dark" },
  system: { theme: "claw", mode: "system" },
  knot: { theme: "claw", mode: "dark" },
  dash: { theme: "claw", mode: "dark" },
};

/**
 * What the viewer's operating system is asking for.
 *
 * Dark when it cannot be asked. A server render, a test environment and an old browser all land
 * here, and dark is what this app looked like for everyone until now -- guessing light would change
 * the appearance of the app for people who never expressed a preference at all.
 */
export function resolveSystemTheme(): ResolvedTheme {
  if (typeof globalThis.matchMedia !== "function") {
    return "dark";
  }
  return globalThis.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
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
 * The palette to actually paint.
 *
 * `custom` wins over the mode because the tweakcn override is a whole palette somebody pasted in,
 * not a variant of ours to take a light version of. It is dark-only, which is why choosing light
 * while a custom theme is active changes nothing -- and why the mode control says so.
 */
export function resolveTheme(theme: ThemeName, mode: ThemeMode): ResolvedTheme {
  if (theme === "custom") {
    return "custom";
  }
  if (mode === "light") {
    return "light";
  }
  if (mode === "dark") {
    return "dark";
  }
  return resolveSystemTheme();
}
