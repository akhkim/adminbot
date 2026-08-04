#!/usr/bin/env python3
"""
AdminBot deadline collector (Output 0 data source).

Refreshes extensions/adminbot/deadlines/venues.json with the lab's UPCOMING
submission/rebuttal deadlines:

  - NeurIPS 2026 workshops  -> collected live from OpenReview
      (group parent = NeurIPS.cc/2026/Workshop). All workshops share the
      OFFICIAL unified NeurIPS deadline: submission 2026-08-29 AoE,
      hard accept/reject 2026-09-29 AoE.
  - Conference milestones    -> curated + source-verified (aideadlines.org /
      ACL Rolling Review / official CFPs). Kept as a small hand-checked table
      because the freeform venues change slowly and must be exact.

Times are AoE (UTC-12). Run:  python3 scripts/adminbot-deadline-collect.py
Only OUTPUT is venues.json; nothing is sent.
"""
import json, os, sys, urllib.request, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(HERE, "..", "extensions", "adminbot", "deadlines", "venues.json")

# --- curated, source-verified upcoming conference milestones (AoE 23:59:59) ---
# Update these when the next cycle's official CFP is announced.
CONFERENCES = [
    dict(id="emnlp2026_commitment", name="EMNLP 2026 (main, ARR commitment)",
         venue_type="conference", venue_group="EMNLP 2026", track="main",
         deadline_label="commitment", deadline_aoe="2026-08-02 23:59:59",
         notification_aoe="2026-08-20 23:59:59", link="https://2026.emnlp.org/"),
    dict(id="neurips2026_rebuttal", name="NeurIPS 2026 — Author rebuttal / discussion",
         venue_type="rebuttal", venue_group="NeurIPS 2026", track="rebuttal",
         deadline_label="rebuttal ends", deadline_aoe="2026-08-03 23:59:59",
         notification_aoe="", link="https://neurips.cc/Conferences/2026"),
    dict(id="arr_2026_august", name="ARR — August 2026 cycle (submission)",
         venue_type="conference", venue_group="ARR August 2026", track="main",
         deadline_label="ARR submission", deadline_aoe="2026-08-03 23:59:59",
         notification_aoe="", link="https://aclrollingreview.org/dates"),
    dict(id="iclr2027_abstract", name="ICLR 2027 (abstract; paper Sep 24)",
         venue_type="conference", venue_group="ICLR 2027", track="main",
         deadline_label="abstract deadline", deadline_aoe="2026-09-19 23:59:59",
         notification_aoe="", link="https://iclr.cc/Conferences/2027"),
    dict(id="naacl2027_paper", name="NAACL 2027 (main, ARR submission)",
         venue_type="conference", venue_group="NAACL 2027", track="main",
         deadline_label="paper submission (ARR)", deadline_aoe="2026-10-12 23:59:59",
         notification_aoe="", link="https://2027.naacl.org/"),
    # EACL 2027 also runs on the ARR August cycle (submission Aug 3 -> commit Oct 11).
    # Uncomment to track it:
    # dict(id="eacl2027_commitment", name="EACL 2027 (ARR commitment)",
    #      venue_type="conference", venue_group="EACL 2027", track="main",
    #      deadline_label="commitment", deadline_aoe="2026-10-11 23:59:59",
    #      notification_aoe="", link="https://2027.eacl.org/"),
]

# Curated non-NeurIPS workshops (each has its own per-workshop deadline).
# Add EMNLP 2026 workshops here as their CFPs are confirmed.
EMNLP_WORKSHOPS = [
    dict(id="emnlp2026_ws_nlp4pi",
         name="NLP4PI — 5th Workshop on NLP for Positive Impact (EMNLP 2026)",
         venue_type="workshop", venue_group="EMNLP 2026 Workshops", track="workshop",
         deadline_label="ARR commitment",   # direct channel (Jul 14) already closed
         deadline_aoe="2026-08-03 23:59:59", notification_aoe="2026-08-15 23:59:59",
         link="https://openreview.net/group?id=EMNLP/2026/Workshop/NLP4PI_ARR_Commitment"),
]

NEURIPS_WS_SUBMISSION = "2026-08-29 23:59:59"   # official recommended (AoE)
NEURIPS_WS_NOTIF      = "2026-09-29 23:59:59"   # official hard accept/reject (AoE)
OPENREVIEW_PARENT     = "NeurIPS.cc/2026/Workshop"


def fetch_neurips_workshops():
    url = f"https://api2.openreview.net/groups?parent={OPENREVIEW_PARENT}"
    req = urllib.request.Request(url, headers={"User-Agent": "jinesis-adminbot/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    pref = OPENREVIEW_PARENT + "/"
    out = {}
    for g in data.get("groups", []):
        gid = g.get("id", "")
        if not gid.startswith(pref):
            continue
        rest = gid[len(pref):]
        if "/" in rest:          # skip /Authors, /Reviewers, ... subgroups
            continue
        c = g.get("content", {}) or {}
        def val(k):
            v = c.get(k); return v.get("value") if isinstance(v, dict) else v
        out[rest] = dict(
            id="neurips2026_ws_" + rest,
            name=val("title") or val("name") or rest,
            venue_type="workshop", venue_group="NeurIPS 2026 Workshops", track="workshop",
            deadline_label="submission", deadline_aoe=NEURIPS_WS_SUBMISSION,
            notification_aoe=NEURIPS_WS_NOTIF,
            link=(val("web") or val("website") or f"https://openreview.net/group?id={gid}"))
    return [out[k] for k in sorted(out)]


def main():
    items = list(CONFERENCES) + list(EMNLP_WORKSHOPS)
    try:
        ws = fetch_neurips_workshops()
        print(f"OpenReview: collected {len(ws)} NeurIPS 2026 workshops")
        items += ws
    except Exception as e:                       # fail soft: keep last venues.json workshops
        print(f"WARN: OpenReview fetch failed ({e}); keeping existing workshop entries", file=sys.stderr)
        try:
            prev = json.load(open(OUT))
            items += [x for x in prev.get("items", []) if x.get("venue_type") == "workshop"]
        except Exception:
            pass
    items.sort(key=lambda x: (x["deadline_aoe"], x["name"]))
    doc = dict(timezone="AoE (UTC-12)",
               note=("Upcoming only. NeurIPS 2026 workshops use the official unified "
                     "deadline (submission 2026-08-29, hard accept/reject 2026-09-29)."),
               count=len(items), items=items)
    json.dump(doc, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"wrote {OUT} with {len(items)} items")

    # keep the served-page dataset (Output 0 Control-UI surface) in sync
    ds = os.path.join(HERE, "..", "extensions", "adminbot", "src", "deadlines-dataset.ts")
    with open(ds, "w") as f:
        f.write("// Generated from extensions/adminbot/deadlines/venues.json by\n"
                "// scripts/adminbot-deadline-collect.py. Do not hand-edit; regenerate instead.\n\n"
                "export const DEADLINE_VENUES = "
                + json.dumps(items, ensure_ascii=False, indent=2) + " as const;\n")
    print(f"wrote {ds}")

    # keep the bundled Control-UI tab dataset in sync (ui/src/ui/deadlines-data.ts)
    keys = ["id", "name", "venue_type", "venue_group", "track",
            "deadline_label", "deadline_aoe", "notification_aoe", "link"]
    slim = [{k: it.get(k, "") for k in keys} for it in items]
    ui_ds = os.path.join(HERE, "..", "ui", "src", "ui", "deadlines-data.ts")
    with open(ui_ds, "w") as f:
        f.write("// Generated from extensions/adminbot/deadlines/venues.json by\n"
                "// scripts/adminbot-deadline-collect.py. Do not hand-edit; regenerate instead.\n\n"
                "export type DeadlineVenue = {\n"
                "  id: string;\n  name: string;\n  venue_type: string;\n  venue_group: string;\n"
                "  track?: string;\n  deadline_label: string;\n  deadline_aoe: string;\n"
                "  notification_aoe?: string;\n  link?: string;\n};\n\n"
                "export const DEADLINE_VENUES: DeadlineVenue[] = "
                + json.dumps(slim, ensure_ascii=False, indent=2) + ";\n")
    print(f"wrote {ui_ds}")


if __name__ == "__main__":
    main()
