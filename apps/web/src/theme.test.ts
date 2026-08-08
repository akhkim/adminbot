import { describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, readColorTheme, writeColorTheme } from "./theme.js";

describe("color theme preference", () => {
  it("defaults invalid or absent values to dark", () => {
    expect(readColorTheme({ getItem: () => null })).toBe("dark");
    expect(readColorTheme({ getItem: () => "system" })).toBe("dark");
  });

  it("round-trips the light preference without storing application data", () => {
    const setItem = vi.fn();
    writeColorTheme({ setItem }, "light");
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    expect(readColorTheme({ getItem: () => "light" })).toBe("light");
  });

  it("continues when browser storage is unavailable", () => {
    expect(
      readColorTheme({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("dark");
    expect(() =>
      writeColorTheme(
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        "light",
      ),
    ).not.toThrow();
  });
});
