#!/usr/bin/env python3
"""
AdminBot contact-roster collector.

Turns the lab's "Jinesis Contact_Paper list with Zhijing" workbook into the committed
fixture the conformance tests read:

    extensions/adminbot/src/workflows/members/generated/contact-roster.ts

Two sheets matter and they answer different questions.

  MemberList / Full Slack Member List -> who the lab has a contact record for, and what it
      believes about them. The union of the two is "the contact list": the Slack export
      carries people the curated list never got a row for, and the curated list carries two
      people who are not in Slack.

  External Collab Access Design -> the access policy, as a matrix of access item x
      collaborator subgroup. This is the sheet `collaborator-subgroups.ts` is a hand-written
      transcription of, and the drift between the two is what the contract test exists to
      catch.

The workbook is not in the repo and must not be: it carries personal phone numbers and
private addresses for 153 people. Only the fields the tests assert on are generated from it,
and the generated file is reviewed like any other diff before it lands.

Reading .xlsx needs openpyxl, which is why this is a Python collector rather than part of the
TypeScript build -- the same split, and for the same reason, as
scripts/adminbot-deadline-collect.py. The repo keeps no spreadsheet dependency of its own.

  python3 scripts/adminbot-contact-roster-collect.py \
      --workbook "/mnt/c/Users/Andrew/Downloads/Jinesis Contact_Paper list with Zhijing (4).xlsx"
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys
import unicodedata

try:
    import openpyxl
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("openpyxl is required: pip install openpyxl")

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT_PATH = REPO_ROOT / "extensions/adminbot/src/workflows/members/generated/contact-roster.ts"

# Sheet column index -> the subgroup key in `adminBotExternalCollaboratorSubgroups`.
#
# Written out rather than derived from the header text: the headers carry the lab's prose
# ("coauthor-minor (5-10 hours/week) or coauthor-discussant"), and a slugifier that happened to
# produce the right key today would silently produce a different one the next time somebody
# edits a header. The contract test asserts this covers the code's vocabulary exactly, so a
# subgroup added on either side fails rather than being quietly dropped here.
SUBGROUP_COLUMNS = {
    1: "slightly_better_than_emails",
    2: "acquaintance",
    3: "alumni",
    4: "interviewee",
    5: "own_pace_advisee",
    6: "coauthor_minor",
    7: "coauthor_major",
    8: "disappearing_coauthor",
    9: "external_prof",
    10: "coauthor_discussant_designer",
}

# The people sheets, by header position. Column 0 is the name and has no header. `location`
# exists only on the Slack export, which is why the two are read with per-sheet maps rather
# than one shared one.
MEMBER_COLUMNS = {
    "MemberList": {
        1: "joined_month",
        2: "graduated_month",
        3: "correspondence_email",
        4: "twitter",
        5: "calendar_email",
        6: "whatsapp",
        7: "openreview",
        8: "github",
        9: "linkedin",
        10: "website",
        11: "lesswrong",
        12: "research_interests",
        13: "notes",
    },
    "Full Slack Member List": {
        1: "joined_month",
        2: "graduated_month",
        3: "location",
        4: "correspondence_email",
        5: "twitter",
        6: "calendar_email",
        7: "whatsapp",
        8: "openreview",
        9: "github",
        10: "linkedin",
        11: "website",
        # The three columns the access audit grades against. `member_type` is the sheet's own
        # statement of which matrix row applies to somebody, and `channels` is the only readable
        # record of whether the Slack half of onboarding actually happened.
        15: "slack_id",
        18: "member_type",
        24: "channels",
    },
}

# Fields carried into the fixture. Phone numbers and free-text notes are deliberately left
# behind: the tests do not assert on them, and a fixture is a file that gets pasted into
# issues and CI logs.
PUBLISHED_FIELDS = {
    "joined_month",
    "graduated_month",
    "location",
    "correspondence_email",
    "calendar_email",
    "openreview",
    "github",
    "linkedin",
    "website",
    "twitter",
    # Added for the access audit (workflows/members/access-audit.ts). None of the three is
    # personal in the way a phone number is: a Slack member id, the lab's own label for the
    # relationship, and a list of the lab's own channel names.
    "slack_id",
    "member_type",
    "channels",
}


def cell_text(value: object) -> str:
    """One cell as trimmed text. Excel dates arrive as datetimes; keep the date only."""
    if value is None:
        return ""
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    return str(value).strip()


def normalize_person_name(value: str) -> str:
    """Mirror of `normalizePersonName` in extensions/adminbot/src/contracts/person-names.ts.

    Kept behaviour-compatible with it on purpose: the fixture's `key` is what the conformance
    test matches roster rows on, so a name folded differently here than in the service would
    report a present member as missing.
    """
    stripped = "".join(
        ch for ch in unicodedata.normalize("NFD", value) if not unicodedata.combining(ch)
    )
    spaced = re.sub(r"[^a-z ]", " ", stripped.lower())
    return re.sub(r"\s+", " ", spaced).strip()


def access_cell(raw: str) -> str:
    """One matrix cell as an `adminBotCollaboratorAccessCells` value.

    The sheet answers most cells with "Y" or a blank and a handful with prose. The prose is not
    decoration -- "Y separate" obliges a different delivery, and "Almost No, but based on their
    case-by-case situation" is not a no -- so each form maps onto the vocabulary the service
    already models rather than collapsing to a boolean.
    """
    text = raw.strip()
    low = text.lower()
    if not text or low == "no":
        return "no"
    if low.startswith("almost no"):
        return "case_by_case"
    if low.startswith("auto-reply"):
        return "auto_decline"
    if low.startswith("y separate"):
        return "yes_separate"
    if low.startswith("y"):
        return "yes"
    # Never guess. An unrecognised answer is a sheet this collector has not been taught to
    # read, and defaulting it either way would put an invented policy in the fixture.
    raise SystemExit(f"unrecognised access cell {text!r} -- teach access_cell() how to read it")


def rows_of(worksheet) -> list[list[str]]:
    rows = [[cell_text(c) for c in row] for row in worksheet.iter_rows(values_only=True)]
    return [row for row in rows if any(row)]


def header_token(text: str) -> str:
    """A header cell reduced to its subgroup token.

    The sheet's headers carry explanations the columns are keyed on but nobody types exactly:
    "coauthor-major (20-40 hrs/week)", "interviewee\n\ninterviewee-calendar". Everything from the
    first bracket or newline on is commentary, so the token is what survives that cut.
    """
    head = re.split(r"[(\n]", text, maxsplit=1)[0]
    return head.strip().lower().replace(" ", "-").replace("_", "-").strip("-")


def locate_access_header(rows: list[list[str]]) -> tuple[int, int, dict[int, str]]:
    """Find the header row, its label column, and which column answers for which subgroup.

    Located rather than hard-coded because the workbook's shape is not stable: revision (4) put
    the header on the first row with the label in column 0, and revisions (2) and (3) put a
    "To Check" annotation row above it and shifted every column one to the right. A collector
    pinned to fixed indices read the annotation row as the header and produced a matrix of the
    wrong answers -- silently, because every cell it read was still a legal cell.

    So the anchor is the sheet's own words: the row carrying "Access item" is the header, and each
    subgroup's column is the one whose heading names it.
    """
    # The sheet's own spelling of each column, which is not always the subgroup key with dashes:
    # the discussant column reads "coauthor-discussant-or-designer". Stated rather than derived,
    # so a renamed column fails loudly here instead of quietly dropping a subgroup's answers.
    wanted = {
        "slightly-better-than-emails": "slightly_better_than_emails",
        "acquaintance": "acquaintance",
        "alumni": "alumni",
        "interviewee": "interviewee",
        "own-pace-advisee": "own_pace_advisee",
        "coauthor-minor": "coauthor_minor",
        "coauthor-major": "coauthor_major",
        "disappearing-coauthor": "disappearing_coauthor",
        "external-prof": "external_prof",
        "coauthor-discussant-or-designer": "coauthor_discussant_designer",
    }
    if set(wanted.values()) != set(SUBGROUP_COLUMNS.values()):
        raise SystemExit("the header alias table and SUBGROUP_COLUMNS disagree about the subgroups")
    for index, row in enumerate(rows):
        labels = [header_token(cell) for cell in row]
        if "access-item" not in labels:
            continue
        label_column = labels.index("access-item")
        columns = {
            column: wanted[token]
            for column, token in enumerate(labels)
            if token in wanted and column != label_column
        }
        missing = sorted(set(wanted.values()) - set(columns.values()))
        if missing:
            raise SystemExit(
                "access sheet header is missing a column for: " + ", ".join(missing)
            )
        return index, label_column, columns
    raise SystemExit("no row in the access sheet carries an 'Access item' heading")


def collect_access_matrix(worksheet) -> list[dict]:
    rows = rows_of(worksheet)
    header_index, label_column, columns = locate_access_header(rows)
    items = []
    for row in rows[header_index + 1 :]:
        label = row[label_column] if label_column < len(row) else ""
        if not label:
            continue
        # Trailing blanks are trimmed by openpyxl, so a short row means "no" for every column
        # past its end rather than a missing answer.
        cells = {
            key: access_cell(row[index] if index < len(row) else "")
            for index, key in columns.items()
        }
        items.append({"label": label, "cells": cells})
    return items


def collect_members(workbook) -> list[dict]:
    """The union of the two people sheets, keyed by folded name.

    Somebody on both sheets is one contact carrying both sources. The sheets disagree in places
    -- Zhijing's WhatsApp differs between them -- and the curated MemberList answer wins,
    because that is the one the lab maintains by hand. `sources` records where each contact was
    found, so a conformance failure can say which sheet to go and fix.
    """
    contacts: dict[str, dict] = {}
    # Slack export first, so the curated MemberList overwrites it field by field.
    for sheet_name in ("Full Slack Member List", "MemberList"):
        columns = MEMBER_COLUMNS[sheet_name]
        for row in rows_of(workbook[sheet_name])[1:]:
            name = row[0]
            if not name:
                continue
            key = normalize_person_name(name)
            if not key:
                continue
            contact = contacts.setdefault(
                key, {"key": key, "name": name, "sources": [], "fields": {}}
            )
            contact["name"] = name
            if sheet_name not in contact["sources"]:
                contact["sources"].append(sheet_name)
            for index, field in columns.items():
                if field not in PUBLISHED_FIELDS:
                    continue
                value = row[index] if index < len(row) else ""
                if value:
                    contact["fields"][field] = value
    return [contacts[key] for key in sorted(contacts)]


def render(workbook_name: str, members: list[dict], access: list[dict]) -> str:
    payload_members = json.dumps(members, indent=2, ensure_ascii=False)
    payload_access = json.dumps(access, indent=2, ensure_ascii=False)
    subgroups = json.dumps(sorted(SUBGROUP_COLUMNS.values()), indent=2, ensure_ascii=False)
    return f"""// Generated from {workbook_name!r} by scripts/adminbot-contact-roster-collect.py.
// Do not hand-edit; regenerate instead.
//
// The lab's contact list and access policy as the spreadsheet states them. This file is the
// *expectation* side of the conformance tests: where it and the service disagree, the sheet is
// what the lab decided and the service is what it actually got.
//
// Phone numbers and free-text notes are deliberately not carried here -- only the fields the
// tests assert on.

/** Collaborator subgroups the access sheet has a column for. */
export const CONTACT_SHEET_SUBGROUPS = {subgroups} as const;

export type ContactSheetAccessItem = {{
  /** The sheet's own wording for the row, which is how a failure points back at a cell. */
  label: string;
  cells: Record<(typeof CONTACT_SHEET_SUBGROUPS)[number], string>;
}};

/** The access matrix, in sheet row order. */
export const CONTACT_ACCESS_MATRIX: readonly ContactSheetAccessItem[] = {payload_access};

export type ContactSheetMember = {{
  /** `normalizePersonName(name)` -- what a roster row is matched on. */
  key: string;
  name: string;
  sources: string[];
  fields: Record<string, string>;
}};

/** Every person the lab has a contact record for, from both people sheets. */
export const CONTACT_MEMBERS: readonly ContactSheetMember[] = {payload_members};
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", required=True, help="path to the .xlsx")
    parser.add_argument("--out", default=str(OUT_PATH))
    args = parser.parse_args()

    path = pathlib.Path(args.workbook)
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    members = collect_members(workbook)
    access = collect_access_matrix(workbook["External Collab Access Design"])
    workbook.close()

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(path.name, members, access), encoding="utf-8")
    print(f"{len(members)} contacts, {len(access)} access items -> {out}")


if __name__ == "__main__":
    main()
