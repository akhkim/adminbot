// Control UI module implements theme behavior.
//
// Two palettes and a custom escape hatch. The "knot"/"dash" theme families are still gone (design
// spec §2); what came back is light, because a portal people open in a bright room all day is not
// a terminal.
//
// `theme` is which palette family ("claw", or the tweakcn "custom" override), and `mode` is which
// variant of it the viewer wants.
//
// There is no "follow my system" mode any more. It sat behind a monitor icon that people did not
// read as a theme at all, and it made the first paint depend on an OS setting nobody had chosen
// for this app. Dark is the default, as it was before light existed.
export type ThemeName = "claw" | "custom";
export type ThemeMode = "light" | "dark";
export type ResolvedTheme = "dark" | "light" | "custom";

export const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "custom"]);
const VALID_THEME_MODES = new Set<ThemeMode>(["light", "dark"]);

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
  system: { theme: "claw", mode: "dark" },
  knot: { theme: "claw", mode: "dark" },
  dash: { theme: "claw", mode: "dark" },
};

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  const theme = typeof themeRaw === "string" ? themeRaw : "";
  const mode = typeof modeRaw === "string" ? modeRaw : "";

  const normalizedTheme = VALID_THEME_NAMES.has(theme as ThemeName)
    ? (theme as ThemeName)
    : (LEGACY_MAP[theme]?.theme ?? "claw");
  // A stored "system" is the removed mode, not a missing one: it becomes dark outright rather than
  // falling through to whatever a legacy `theme` value would have implied.
  const normalizedMode = VALID_THEME_MODES.has(mode as ThemeMode)
    ? (mode as ThemeMode)
    : mode === "system"
      ? "dark"
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
  return mode === "light" ? "light" : "dark";
}
