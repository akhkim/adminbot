#!/usr/bin/env python3
"""
AdminBot deadline matcher (Output 2, step 1).

Maps lab papers to the UPCOMING deadlines in venues.json:

  ONGOING papers ("Paper submissions" tab)  -> target venue via the `Venue`
      column (freeform, e.g. "EMNLP 100%", "NeurIPS 100%", "90% ARR Aug",
      "ICLR 77.77%").  High-confidence, deterministic.

  READY papers ("Formatted Papers" tab, Year >= currentYear-1) -> candidate
      NeurIPS 2026 workshops via TOPIC match (keyword + curated concept boosts).
      Fuzzy: emitted as SUGGESTIONS that a human confirms before any nudge.

Input CSVs are read from local files (produced by `gog`/`gws` export on the
server) or fetched via the Google Sheets CSV endpoint. Output: matches.json.

Env / args:
  --ongoing-csv PATH   --ready-csv PATH        (local CSV, preferred on server)
  --now YYYY-MM-DD      (default: today)        --out matches.json
Sheet IDs (used only if no local CSV given; must be readable by the caller):
  ADMINBOT_ONGOING_SHEET_ID (tab "Paper submissions", gid 846550934)
  ADMINBOT_READY_SHEET_ID   (tab "Formatted Papers",  gid 1634319760)
"""
import csv, io, json, os, re, sys, math, argparse, urllib.request
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adminbot_deadlines import AoEClock, DEADLINES_DIR as DDIR

# ongoing Venue-string -> venue_group key used in venues.json
TARGET_TO_GROUP = {
    "EMNLP 2026 (commitment)": "EMNLP 2026",
    "NeurIPS 2026 (rebuttal)": "NeurIPS 2026",
    "ARR August cycle":        "ARR August 2026",
    "NAACL 2027":              "NAACL 2027",
    "ICLR 2027":               "ICLR 2027",
    "NeurIPS 2026 Workshop":   "NeurIPS 2026 Workshops",
}


def classify_ongoing(v):
    s = (v or "").strip(); low = s.lower()
    if not s:
        return None
    if "arr" in low and "aug" in low:
        return "ARR August cycle"
    if "emnlp" in low:
        return None if "demo" in low else "EMNLP 2026 (commitment)"
    if "neurips" in low:
        return "NeurIPS 2026 Workshop" if "workshop" in low else "NeurIPS 2026 (rebuttal)"
    if "iclr" in low:
        return "ICLR 2027"
    if "naacl" in low:
        return "NAACL 2027"
    return None    # AAAI / journal / passed / "unsure" -> not auto-scheduled


def split_authors(a):
    return [x.strip() for x in re.split(r"[,/&]| and ", a or "") if x.strip() and x.strip() != "?"]


# ---------- topic match (ready -> NeurIPS workshop) ----------
STOP = set(("the a an of for and to in on with under via using from is are workshop neurips 2026 2025 "
            "track towards toward new first second third annual conference machine learning at systems "
            "models model foundation large language ai its into how when what who real world through beyond "
            "it be can we our their than not more most").split())


def toks(s):
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    out = []
    for w in s.split():
        if w in STOP or len(w) < 3:
            continue
        w = re.sub(r"(ing|tion|s)$", "", w)
        if len(w) >= 3:
            out.append(w)
    return out


CONCEPTS = [
    (r"interpret|probe|circuit|representation|activation|transcoder|latent", ["Interp4Discovery", "IAB", "EIML", "XAI4Science"]),
    (r"multi.?agent|\bagent|cooperation|social dilemma|negotiat|game theor|institutional|society|societies", ["FAST", "Meta-Agents", "SocialAgent", "IAEval", "Verify-Agents", "PTA", "SLM-Agents"]),
    (r"safety|jailbreak|harmful|adversar|robust|defense|attack|misalign|deception|scheming|faking|tamper", ["FLMSec", "AI4GOOD", "Verify-Agents", "Child_Safety_in_AI"]),
    (r"privacy|private|unlearn", ["InfPriv", "MPLR-FM"]),
    (r"math|reasoning|theorem|logic", ["MATH-AI"]),
    (r"reinforce|\brl\b|policy|reward|rlvr", ["PTA", "RL4XS", "RoboPAD"]),
    (r"eval|judge|benchmark|assess", ["JUDGe", "IAEval"]),
    (r"causal|scientific|science|discovery|meta.?science|astro|physic", ["AI4MetaScience", "Sim2Sci", "XAI4Science", "Interp4Discovery", "PhysUnderstand", "RPS"]),
    (r"memory", ["PALM"]),
    (r"continual|lifelong", ["CL4FMAgents", "CLEA", "TTCL"]),
    (r"distill|small|efficient|deploy|on.?device", ["LIGHT", "SLM-Agents", "ODI", "AXIOM"]),
    (r"vision|visual|vlm|3d|image|multimodal|spatial|grounding|medical|clinical|pathology", ["VLM4RWD", "ReMuCAI", "ML4SpatialBio", "ASCI", "GenAI4Health"]),
    (r"code|coding|verif", ["VERICODEGEN"]),
    (r"democra|authoritarian|political|rights|election|moral|ethic|govern", ["AI4GOOD", "SocialAgent", "AI-Native_Academia", "AI_and_the_Self", "nlp4pi"]),
    (r"positive impact|social good|for good|sustainab|poverty|hunger|climate|inequal|human right|social system|social issue|societ", ["nlp4pi", "AI4GOOD"]),
    (r"cross.?ling|multiling|translat", ["LP4FM"]),
    (r"optim|transport", ["OPT", "GDDL", "DynaFront", "AXIOM"]),
]
TOPIC_THRESHOLD = 3.0


def build_workshop_registry(clock=None):
    # Every upcoming workshop across venues.json, keyed by the code after "_ws_".
    # The dataset retains expired records for the Past view; matching must not suggest them.
    clock = clock or AoEClock.resolve()
    items = json.load(open(os.path.join(DDIR, "venues.json")))["items"]
    reg = {}
    for it in items:
        if it.get("venue_type") != "workshop":
            continue
        try:
            if clock.has_passed(it["deadline_aoe"]):
                continue
        except (KeyError, ValueError):
            continue
        reg[it["id"].rsplit("_ws_", 1)[-1]] = it
    return reg


def build_workshop_index(reg):
    WT = {code: Counter(toks(it["name"])) for code, it in reg.items()}
    df = Counter()
    for cnt in WT.values():
        for t in cnt:
            df[t] += 1
    N = max(1, len(WT))
    idf = {t: math.log(1 + N / df[t]) for t in df}
    return WT, idf


def topic_match(title, topic, WT, idf):
    q = Counter(toks(f"{title} {topic or ''}"))
    text = f"{title} {topic or ''}".lower()
    sc = defaultdict(float)
    for c, cnt in WT.items():
        s = sum(idf.get(t, 0) * min(q[t], cnt[t]) for t in q if t in cnt)
        if s > 0:
            sc[c] += s
    for pat, codes in CONCEPTS:
        if re.search(pat, text):
            for c in codes:
                sc[c] += 2.5
    return [(c, round(s, 1)) for c, s in sorted(sc.items(), key=lambda x: -x[1])[:3] if s >= TOPIC_THRESHOLD]


# ---------- CSV loading ----------
def read_csv(local, sheet_id, gid, tab):
    if local:
        return list(csv.reader(open(local)))
    if not sheet_id:
        raise SystemExit("no CSV path and no sheet id; pass --ongoing-csv/--ready-csv")
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
    req = urllib.request.Request(url, headers={"User-Agent": "jinesis-adminbot/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return list(csv.reader(io.StringIO(r.read().decode("utf-8", "replace"))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ongoing-csv"); ap.add_argument("--ready-csv")
    ap.add_argument("--now", help="YYYY-MM-DD or ISO-8601 instant (default: now)")
    ap.add_argument("--out", default=os.path.join(DDIR, "matches.json"))
    a = ap.parse_args()
    clock = AoEClock.resolve(a.now)
    cur_year = clock.today.year

    venue_items = json.load(open(os.path.join(DDIR, "venues.json")))["items"]
    venues = {}
    for venue in venue_items:
        if clock.has_passed(venue["deadline_aoe"]):
            continue
        group = venue["venue_group"]
        if group not in venues or venue["deadline_aoe"] < venues[group]["deadline_aoe"]:
            venues[group] = venue

    # ONGOING
    rows = read_csv(a.ongoing_csv, os.environ.get("ADMINBOT_ONGOING_SHEET_ID"), "846550934", "Paper submissions")
    ongoing = []
    for r in rows:
        if len(r) < 4:
            continue
        t, v, au = (r[1] or "").strip(), (r[2] or "").strip(), (r[3] or "").strip()
        if not t or not v or t.lower() == "title" or t.lower().startswith(("sorting", "first batch", "second batch")):
            continue
        tgt = classify_ongoing(v)
        if tgt and tgt in TARGET_TO_GROUP and TARGET_TO_GROUP[tgt] in venues:
            grp = TARGET_TO_GROUP[tgt]
            ongoing.append(dict(kind="ongoing", title=t, raw_venue=v, target=tgt,
                                venue_group=grp, deadline_aoe=venues[grp]["deadline_aoe"],
                                authors=split_authors(au), confirmed=True))

    # READY -> workshop suggestions. Topic-match against every workshop; each match
    # carries its own venue/deadline (so a lone NLP4PI match keeps its Aug 3 date).
    reg = build_workshop_registry(clock)
    WT, idf = build_workshop_index(reg)
    rows = read_csv(a.ready_csv, os.environ.get("ADMINBOT_READY_SHEET_ID"), "1634319760", "Formatted Papers")
    ready = []
    for r in rows[1:]:
        if len(r) <= 23:
            continue
        yr = (r[0] or "").strip()
        if not yr.isdigit() or int(yr) < cur_year - 1:
            continue
        title = (r[1] or "").strip()
        if not title:
            continue
        picks = topic_match(title, r[23], WT, idf)
        if not picks:
            continue
        top = reg[picks[0][0]]
        ready.append(dict(kind="ready", title=title, year=yr,
                          authors=split_authors(r[10]),
                          venue_group=top["venue_group"], deadline_aoe=top["deadline_aoe"],
                          suggestions=[dict(code=c, name=reg[c]["name"],
                                            venue_group=reg[c]["venue_group"],
                                            deadline_aoe=reg[c]["deadline_aoe"], score=s)
                                       for c, s in picks],
                          confirmed=False))   # requires human confirmation before nudging

    out = dict(generated=clock.now.isoformat(), ongoing_count=len(ongoing), ready_suggestion_count=len(ready),
               ongoing=ongoing, ready=ready)
    json.dump(out, open(a.out, "w"), indent=2, ensure_ascii=False)
    print(f"matched {len(ongoing)} ongoing papers -> live cadence")
    print(f"topic-matched {len(ready)} ready papers -> workshop SUGGESTIONS (need confirmation)")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
