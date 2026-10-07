# Gog Drive metadata envelope regression

Actual production-styled profile component with synthetic member links. Status messages come from the durable SQLite service and real Gog probe running a local Node stand-in command that emits Gog CLI’s official `{file: {...}}` JSON shape. No Google requests, live record changes, or permission changes.

Base: `9bb88f3562ebfc1916f48c670ac082eccce5cf8f`. Before: capabilities are ignored and both fields say edit access cannot be confirmed. After: the same editable folder metadata verifies both fields. Desktop 1000px, light/dark, and iPhone 14 width 390px; native browser detail captures. All saved files visually inspected.

Primary format source: https://github.com/openclaw/gogcli/blob/414e2ff8afa281ec3d9f0cdb057bdbc53386db91/internal/cmd/drive.go#L138-L145

Regression tests cover true/true, true/false and false/true folder capabilities. Existing raw/result formats and missing/unreadable behavior remain covered by the focused suite.
