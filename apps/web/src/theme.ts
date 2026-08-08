export type ColorTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "adminbot.color-theme";

export function readColorTheme(storage: Pick<Storage, "getItem">): ColorTheme {
  try {
    return storage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function writeColorTheme(
  storage: Pick<Storage, "setItem">,
  theme: ColorTheme,
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is optional. Restricted storage must not prevent the application loading.
  }
}
