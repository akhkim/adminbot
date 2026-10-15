# Light/dark theme toggle icons

Synthetic evidence only. The Control UI ran under `pnpm ui:dev` with no gateway and no login, and
no live records were involved. Captured with Playwright against system Chrome at 2x.

- `*-public-shell-{light,dark}.png` — the real signed-out shell at `/opportunities`. The page was
  loaded, and the toggle was clicked once if needed to reach the other theme.
- `*-topbar-{light,dark}.png` — a throwaway component fixture (not committed). It renders the
  signed-in topbar row (search, notification bell, `renderTopbarThemeModeToggle`) with the
  production stylesheet, one row per stored mode.

Before (origin/main):

- The public shell toggle had no CSS. It rendered as a native grey button with a 0x0 svg, so no
  moon or sun appeared in either theme. It also carried `aria-pressed` next to a label that flips
  with state.
- The topbar toggle cycled System -> Light -> Dark. It showed the mode that was set (monitor, sun
  or moon) at 14px in `--muted`, so next to the 18px `--text` bell it read as faint or disabled on
  the white topbar. The monitor glyph for "System" was not understood as a theme control.

After:

- Light and dark are the only modes, and dark is the default. A stored `system` is read as dark,
  by `theme.ts`, by `storage.ts` and by the pre-paint script in `index.html`.
- Both toggles use one convention: the icon is the theme a click switches to, and the
  `aria-label`/`title` say the same ("Switch to light mode" with a sun on dark, "Switch to dark
  mode" with a moon on light).
- Icons are 18px and stroke in `currentColor`. The topbar toggle is `--text` like the bell. The
  public toggle matches the 40px bordered back button.

Measured on the public toggle after the change: svg 18x18, `fill: none`. The stroke is
rgb(9, 9, 11) on white in light mode and rgb(250, 250, 250) on #09090b in dark mode.
