#!/usr/bin/env python3
"""
Generate extensions/adminbot/src/workflows/deadlines/board.ts from the self-contained
board template extensions/adminbot/content/deadlines/deadlines-board.html.

`renderDeadlinesWebUi(items)` returns the board HTML with the embedded dataset
replaced at render time from DEADLINE_VENUES (see mock-service.ts GET /deadlines).
Run after editing the board template.  Output is TypeScript; no runtime I/O.
"""
import os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adminbot_deadlines import DEADLINES_DIR, REPO_ROOT

BOARD = os.path.join(DEADLINES_DIR, "deadlines-board.html")
OUT = os.path.join(REPO_ROOT, "extensions", "adminbot", "src", "workflows", "deadlines", "board.ts")


def main():
    board = open(BOARD).read()
    board = re.sub(
        r"const DATA = \[.*?\];\n",
        "const DATA = __ITEMS_JSON__;\n",
        board,
        count=1,
        flags=re.DOTALL,
    )
    if "__ITEMS_JSON__" not in board:
        raise SystemExit("board template has no `const DATA = ...;` line to replace")
    # escape for a TS template literal: backslash, then backtick, then ${ (keep placeholder literal)
    esc = board.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    ts = ("// Generated from extensions/adminbot/content/deadlines/deadlines-board.html by\n"
          "// scripts/adminbot-deadline-web-ui-gen.py. Do not hand-edit; regenerate instead.\n"
          "// Renders the self-contained live deadline countdown board (Output 0).\n\n"
          'import { DEFAULT_ADMINBOT_CONTROL_UI_URL } from "../../contracts/control-ui.js";\n\n'
          "const TEMPLATE = `" + esc + "`;\n\n"
          "function escapeAttribute(value: string): string {\n"
          '  return value.replaceAll("&", "&amp;").replaceAll(\'"\', "&quot;").replaceAll("<", "&lt;");\n'
          "}\n\n"
          "export function renderDeadlinesWebUi(\n"
          "  items: readonly unknown[],\n"
          "  options: { proposalUrl?: string } = {},\n"
          "): string {\n"
          "  const proposalUrl = options.proposalUrl ??\n"
          "    `${DEFAULT_ADMINBOT_CONTROL_UI_URL}/adminbot/deadlines`;\n"
          '  return TEMPLATE.replace("__ITEMS_JSON__", JSON.stringify(items)).replace(\n'
          '    "__DEADLINE_PROPOSAL_URL__",\n'
          "    escapeAttribute(proposalUrl),\n"
          "  );\n"
          "}\n")
    open(OUT, "w").write(ts)
    print(f"wrote {OUT} ({len(ts)} bytes)")


if __name__ == "__main__":
    main()
