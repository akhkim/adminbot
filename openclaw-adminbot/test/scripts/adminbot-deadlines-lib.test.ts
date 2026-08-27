import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The deadline scripts fire real Slack DMs from cron and had no tests at all.
// These exercise the shared library (scripts/adminbot_deadlines.py) and the two
// runners' pure decision functions by importing them in a subprocess and
// printing JSON back, which is how the reimbursement helper is already tested.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptsDir = path.join(repoRoot, "scripts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runPython(body: string): unknown {
  const preamble = [
    "import json, sys, importlib.util",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "from adminbot_deadlines import AoEClock, DeadlineDataset, SlackNotifier, urgency_marker, archival_status_of, entry_type_of, venue_priority_of, WORKSHOP_FAMILIES, is_sweep_due, sweep_interval_days",
    "def load(name):",
    `    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ${JSON.stringify(scriptsDir)} + '/' + name + '.py')`,
    "    module = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(module)",
    "    return module",
  ].join("\n");
  const stdout = execFileSync("python3", ["-c", `${preamble}\n${body}`], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

function datasetDir(venues: Array<Record<string, unknown>>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-deadlines-test-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "venues.json"),
    JSON.stringify({ timezone: "AoE (UTC-12)", count: venues.length, items: venues }),
  );
  return directory;
}

const venue = (id: string, deadline: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Venue ${id}`,
  venue_type: "conference",
  venue_group: "Group",
  deadline_label: "submission",
  deadline_aoe: deadline,
  ...extra,
});

describe("AoEClock", () => {
  it("treats an AoE stamp as expiring twelve hours later in UTC", () => {
    expect(
      runPython("print(json.dumps(AoEClock.instant('2026-08-29 23:59:59').isoformat()))"),
    ).toBe("2026-08-30T11:59:59+00:00");
  });

  // Every venue uses a 23:59:59 stamp, so the instant always lands on the next
  // calendar day. Reporting that day to an author moves their deadline.
  it("reports the AoE calendar date rather than the shifted UTC date", () => {
    expect(
      runPython(
        "print(json.dumps({'label': AoEClock.calendar_label('2026-08-29 23:59:59'), " +
          "'date': AoEClock.calendar_date('2026-08-29 23:59:59').isoformat(), " +
          "'instant_date': AoEClock.instant('2026-08-29 23:59:59').date().isoformat()}))",
      ),
    ).toEqual({ label: "Aug 29", date: "2026-08-29", instant_date: "2026-08-30" });
  });

  it("counts whole days remaining and detects a passed deadline", () => {
    expect(
      runPython(
        "c = AoEClock.resolve('2026-08-04')\n" +
          "print(json.dumps({'days': c.days_until('2026-08-29 23:59:59'), " +
          "'passed': c.has_passed('2026-08-01 23:59:59'), " +
          "'future': c.has_passed('2026-08-29 23:59:59')}))",
      ),
    ).toEqual({ days: 25, passed: true, future: false });
  });

  it("fires a cadence step on exactly one day", () => {
    // T-30 for an Aug 29 AoE deadline lands on Jul 31 (instant is Aug 30 UTC).
    expect(
      runPython(
        "days = [d for d in ['2026-07-30', '2026-07-31', '2026-08-01'] " +
          "if AoEClock.resolve(d).is_cadence_day('2026-08-29 23:59:59', 30)]\n" +
          "print(json.dumps(days))",
      ),
    ).toEqual(["2026-07-31"]);
  });

  it("prefers an explicit date over the ADMINBOT_DEADLINE_NOW override", () => {
    expect(
      runPython(
        "import os\n" +
          "os.environ['ADMINBOT_DEADLINE_NOW'] = '2026-01-01'\n" +
          "print(json.dumps([AoEClock.resolve('2026-08-04').today.isoformat(), " +
          "AoEClock.resolve(None).today.isoformat()]))",
      ),
    ).toEqual(["2026-08-04", "2026-01-01"]);
  });

  it("uses an explicit instant at the AoE boundary", () => {
    expect(
      runPython(
        "print(json.dumps([AoEClock.resolve('2026-08-30T11:00:00Z').has_passed('2026-08-29 23:59:59'), " +
          "AoEClock.resolve('2026-08-30T12:00:00Z').has_passed('2026-08-29 23:59:59')]))",
      ),
    ).toEqual([false, true]);
  });
});

describe("urgency_marker", () => {
  it("escalates as the deadline approaches and shares the Control UI bands", () => {
    expect(
      runPython("print(json.dumps([urgency_marker(d) for d in [0, 3, 4, 7, 8, 30, 31]]))"),
    ).toEqual(["🔴", "🔴", "🟠", "🟠", "🟡", "🟡", "🟢"]);
  });
});

describe("venue classification", () => {
  it("keeps entry type, archival status, and priority independent", () => {
    expect(
      runPython(
        "print(json.dumps({" +
          "'primary': [entry_type_of('conference', 'main'), archival_status_of('ACL', 'main'), venue_priority_of('ACL', 'main')], " +
          "'secondary': [entry_type_of('conference', 'demo'), archival_status_of('AACL', 'demo'), venue_priority_of('AACL', 'demo')], " +
          "'workshop': [entry_type_of('workshop', 'workshop'), archival_status_of('ACL', 'workshop'), venue_priority_of('ACL', 'workshop')], " +
          "'unknown': archival_status_of('Unlisted', 'main'), " +
          "'explicit_non_archival': archival_status_of('IASEAI', 'main')}))",
      ),
    ).toEqual({
      primary: ["main_conference", "archival", "primary"],
      secondary: ["demo_track", "archival", "secondary"],
      workshop: ["workshop", "unknown", "standard"],
      unknown: "unknown",
      explicit_non_archival: "non_archival",
    });
  });

  it("does not derive the workshop sweep from ARR or archival families", () => {
    expect(runPython("print(json.dumps(list(WORKSHOP_FAMILIES)))")).toEqual([
      "ACL",
      "EMNLP",
      "NAACL",
      "EACL",
      "NeurIPS",
      "ICML",
      "ICLR",
      "COLM",
    ]);
  });
});

describe("workshop source URLs", () => {
  it("classifies workshop publication policy only from explicit CFP language", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "print(json.dumps([m.archival_status_from_html('<p>Accepted papers will be published in the proceedings.</p>'), " +
          "m.archival_status_from_html('<p>This is a non-archival workshop.</p>'), " +
          "m.archival_status_from_html('<p>Accepted papers will be published in the proceedings. We also accept non-archival papers.</p>'), " +
          "m.archival_status_from_html('<p>We invite submissions.</p>')]))",
      ),
    ).toEqual(["archival", "non_archival", "mixed", "unknown"]);
  });

  it("keeps cross-submission rules explicit and extracts bounded topic evidence", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "allowed = m.cross_submission_from_html('<p>Dual submissions are allowed.</p>')\n" +
          "allowed_review = m.cross_submission_from_html('<p>Work under review elsewhere is welcome.</p>')\n" +
          "allowed_concurrent = m.cross_submission_from_html('<p>Submissions may be concurrently submitted elsewhere.</p>')\n" +
          "blocked = m.cross_submission_from_html('<p>Papers must not be under review elsewhere.</p>')\n" +
          "faq = m.cross_submission_from_html('<h2>Are dual submissions allowed?</h2>')\n" +
          "after_acceptance = m.cross_submission_from_html('<p>If accepted, the paper cannot be submitted elsewhere.</p>')\n" +
          "acceptance_suffix = m.cross_submission_from_html('<p>The paper cannot be submitted elsewhere after acceptance.</p>')\n" +
          "unclear = m.cross_submission_from_html('<p>We welcome strong papers.</p>')\n" +
          "topics = m.topic_profile_from_html('<h2>Topics of interest include</h2><p>AI safety; interpretability; reliable agents.</p><h2>Important dates</h2>')\n" +
          "parenthesized = m.topic_profile_from_html('<h2>Topics of interest include</h2><p>GEPA, tools, Trace), evaluation.</p><h2>Important dates</h2>')\n" +
          "print(json.dumps([allowed[0], allowed_review[0], allowed_concurrent[0], blocked[0], faq[0], after_acceptance[0], acceptance_suffix[0], unclear[0], topics, parenthesized[0]]))",
      ),
    ).toEqual([
      "allowed",
      "allowed",
      "allowed",
      "prohibited",
      "unclear",
      "unclear",
      "unclear",
      "unclear",
      [
        ["AI safety", "interpretability", "reliable agents"],
        "AI safety; interpretability; reliable agents.",
      ],
      ["GEPA", "tools", "Trace", "evaluation"],
    ]);
  });

  it("normalizes published links and rejects unsafe schemes", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "print(json.dumps([m.normalize_url('workshop.example/cfp'), m.normalize_url('http://old.example; https://workshop.example/cfp'), m.normalize_url('javascript:alert(1)'), m.openreview_url('EMNLP/2026/Workshop/Example')]))",
      ),
    ).toEqual([
      "https://workshop.example/cfp",
      "https://workshop.example/cfp",
      "",
      "https://openreview.net/group?id=EMNLP/2026/Workshop/Example",
    ]);
  });

  it("keeps a dedicated CFP separate from the workshop homepage", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "pages = {" +
          "'https://workshop.example/': ('https://workshop.example/', '<a href=\"call/\">Call for Papers</a>'), " +
          "'https://workshop.example/call/': ('https://workshop.example/call/', '<h1>CFP</h1>')}\n" +
          "m._fetch_html = lambda url, timeout=15: pages[url]\n" +
          "print(json.dumps([m.discover_cfp_url('https://workshop.example/'), m.discover_cfp_url('https://workshop.example/', 'https://workshop.example/')]))",
      ),
    ).toEqual(["https://workshop.example/call/", "https://workshop.example/call/"]);
  });

  it("does not mislabel a parent conference CFP as a workshop CFP", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "pages = {'https://neurips.cc/Conferences/2035': ('https://neurips.cc/Conferences/2035', '<a href=\"/Conferences/2035/CallForPapers\">Call for Papers</a>'), 'https://neurips.cc/Conferences/2035/CallForPapers': ('https://neurips.cc/Conferences/2035/CallForPapers', '<h1>Main conference</h1>')}\n" +
          "m._fetch_html = lambda url, timeout=15: pages[url]\n" +
          "print(json.dumps(m.discover_cfp_url('https://neurips.cc/Conferences/2035')))",
      ),
    ).toBe("");
  });

  it("refreshes a workshop deadline before falling back to the previous value", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "m._openreview_get = lambda *args, **kwargs: {'groups': [{'id': 'TEST/2035/Workshop/Example', 'content': {'title': {'value': 'Example'}}}]}\n" +
          "m._openreview_submission_deadline = lambda group_id: '2035-01-03 23:59:59'\n" +
          "source = {'parent': 'TEST/2035/Workshop', 'id_prefix': 'test2035_ws_', 'deadline_aoe': '', 'notification_aoe': '', 'family': 'ACL', 'group': 'TEST 2035 Workshops'}\n" +
          "previous = {'test2035_ws_Example': {'deadline_aoe': '2035-01-02 23:59:59'}}\n" +
          "print(json.dumps(m.fetch_workshop_source(source, previous)[0]['deadline_aoe']))",
      ),
    ).toBe("2035-01-03 23:59:59");
  });

  it("marks a retained workshop deadline as unobserved without advancing its source check", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "m._openreview_get = lambda *args, **kwargs: {'groups': [{'id': 'TEST/2035/Workshop/Example', 'content': {'title': {'value': 'Example'}}}]}\n" +
          "m._openreview_submission_deadline = lambda group_id: ''\n" +
          "source = {'parent': 'TEST/2035/Workshop', 'id_prefix': 'test2035_ws_', 'deadline_aoe': '', 'notification_aoe': '', 'family': 'ACL', 'group': 'TEST 2035 Workshops'}\n" +
          "previous = {'test2035_ws_Example': {'deadline_aoe': '2035-01-02 23:59:59', 'source_checked_at': '2034-12-01T00:00:00Z'}}\n" +
          "item = m.fetch_workshop_source(source, previous)[0]\n" +
          "print(json.dumps([item['_source_observed'], item['source_checked_at']]))",
      ),
    ).toEqual([false, "2034-12-01T00:00:00Z"]);
  });

  it("shares one canonical workshop identity across direct and ARR commitment routes", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "base = {'venue_type': 'workshop', 'venue_group': 'EMNLP 2035 Workshops', 'track': 'workshop', 'venue_family': 'EMNLP', 'deadline_label': 'submission', 'deadline_aoe': '2035-01-02 23:59:59'}\n" +
          "direct = m.classify(dict(base, id='emnlp2035_ws_MINT', name='MINT', openreview_url='https://openreview.net/group?id=EMNLP/2035/Workshop/MINT'))\n" +
          "commit = m.classify(dict(base, id='emnlp2035_ws_MINT_ARR_Commitment', name='MINT ARR', openreview_url='https://openreview.net/group?id=EMNLP/2035/Workshop/MINT_ARR_Commitment'))\n" +
          "print(json.dumps([m.merge_history(direct)['venue_id'], m.merge_history(commit)['venue_id']]))",
      ),
    ).toEqual(["EMNLP/2035/Workshop/MINT", "EMNLP/2035/Workshop/MINT"]);
  });
});

describe("deadline history", () => {
  it("appends a changed date while keeping one current projection", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "old = {'id':'iclr2027_paper','entry_type':'main_conference','venue_family':'ICLR','track':'main','deadline_aoe':'2026-09-25 23:59:59','deadline_label':'paper','link':'https://example.test'}\n" +
          "new = dict(old, deadline_aoe='2026-09-26 23:59:59')\n" +
          "item = m.merge_history(new, old)\n" +
          "print(json.dumps({'current': item['deadline_aoe'], 'dates': [r['deadline_aoe'] for r in item['revisions']], 'aliases': item['venue_aliases']}))",
      ),
    ).toEqual({
      current: "2026-09-26 23:59:59",
      dates: ["2026-09-25 23:59:59", "2026-09-26 23:59:59"],
      aliases: ["ICLR", "iclr2027_paper"],
    });
  });

  it("keeps retained past workshops out of new matching suggestions", () => {
    const directory = datasetDir([
      venue("emnlp2026_ws_old", "2026-08-01 23:59:59", { venue_type: "workshop" }),
      venue("emnlp2026_ws_open", "2026-09-01 23:59:59", { venue_type: "workshop" }),
    ]);
    expect(
      runPython(
        "import datetime\n" +
          "m = load('adminbot-deadline-match')\n" +
          `m.DDIR = ${JSON.stringify(directory)}\n` +
          "print(json.dumps(sorted(m.build_workshop_registry(AoEClock(datetime.date(2026, 8, 24))).keys())))",
      ),
    ).toEqual(["open"]);
  });
});

describe("DeadlineDataset.upcoming", () => {
  it("returns only venues inside the window, soonest first", () => {
    const directory = datasetDir([
      venue("late", "2026-12-01 23:59:59"),
      venue("soon", "2026-08-10 23:59:59"),
      venue("passed", "2026-07-01 23:59:59"),
      venue("mid", "2026-08-20 23:59:59"),
    ]);

    expect(
      runPython(
        `d = DeadlineDataset(${JSON.stringify(directory)})\n` +
          "print(json.dumps([v['id'] for v in d.upcoming(AoEClock.resolve('2026-08-04'), 45)]))",
      ),
    ).toEqual(["soon", "mid"]);
  });

  it("excludes a deadline that has already expired today", () => {
    const directory = datasetDir([venue("today", "2026-08-03 23:59:59")]);

    expect(
      runPython(
        `d = DeadlineDataset(${JSON.stringify(directory)})\n` +
          "print(json.dumps([v['id'] for v in d.upcoming(AoEClock.resolve('2026-08-04'), 45)]))",
      ),
    ).toEqual([]);
  });

  it("returns expired current projections newest first", () => {
    const directory = datasetDir([
      venue("old", "2026-06-01 23:59:59"),
      venue("future", "2026-09-01 23:59:59"),
      venue("recent", "2026-08-03 23:59:59"),
    ]);

    expect(
      runPython(
        `d = DeadlineDataset(${JSON.stringify(directory)})\n` +
          "print(json.dumps([v['id'] for v in d.past(AoEClock.resolve('2026-08-04'))]))",
      ),
    ).toEqual(["recent", "old"]);
  });
});

describe("SlackNotifier", () => {
  it("sends nothing unless delivery is explicitly enabled", () => {
    expect(
      runPython(
        "calls = []\n" +
          "n = SlackNotifier(send=False, cli='cli.mjs', runner=lambda *a, **k: calls.append(a))\n" +
          "sent = n.send('#chan', 'hello')\n" +
          "print(json.dumps({'sent': sent, 'calls': len(calls), 'delivered': n.delivered, 'mode': n.mode}))",
      ),
    ).toEqual({ sent: false, calls: 0, delivered: 0, mode: "dry-run" });
  });

  it("shells the OpenClaw CLI with a user target when delivery is enabled", () => {
    expect(
      runPython(
        "calls = []\n" +
          "n = SlackNotifier(send=True, cli='cli.mjs', runner=lambda argv, **k: calls.append(argv))\n" +
          "n.send_to_user('U123', 'ping')\n" +
          "print(json.dumps({'argv': calls[0], 'delivered': n.delivered, 'mode': n.mode}))",
      ),
    ).toEqual({
      argv: [
        "node",
        "cli.mjs",
        "message",
        "send",
        "--channel",
        "slack",
        "--target",
        "user:U123",
        "--message",
        "ping",
        "--json",
      ],
      delivered: 1,
      mode: "SEND",
    });
  });
});

describe("deadline digest message", () => {
  it("lists conferences individually and collapses the shared workshop deadline", () => {
    const directory = datasetDir([
      venue("conf", "2026-08-10 23:59:59", { name: "EMNLP 2026", link: "https://emnlp.example" }),
      venue("ws1", "2026-08-29 23:59:59", {
        venue_type: "workshop",
        venue_group: "NeurIPS 2026 Workshops",
        name: "WS One",
      }),
      venue("ws2", "2026-08-29 23:59:59", {
        venue_type: "workshop",
        venue_group: "NeurIPS 2026 Workshops",
        name: "WS Two",
      }),
      venue("ws3", "2026-08-20 23:59:59", {
        venue_type: "workshop",
        venue_group: "Other 2026 Workshops",
        name: "Lone Workshop",
      }),
      venue("ws4", "2026-08-29 12:00:00", {
        venue_type: "workshop",
        venue_group: "NeurIPS 2026 Workshops",
        name: "Different Time Workshop",
      }),
    ]);

    const message = runPython(
      "m = load('adminbot-deadline-channel-digest')\n" +
        "c = AoEClock.resolve('2026-08-04')\n" +
        `v = DeadlineDataset(${JSON.stringify(directory)}).upcoming(c, 45)\n` +
        "print(json.dumps(m.build_message(v, c, 45)))",
    ) as string;

    expect(message).toContain("🟠 *Aug 10* (6d) — EMNLP 2026  <https://emnlp.example|↗>");
    // Collapsing keys off the dataset's venue_group, so the line names whichever series shares
    // the date and a series of one still shows under its own name.
    expect(message).toContain("*2 NeurIPS 2026 Workshops* (unified deadline)");
    expect(message).not.toContain("WS Two");
    expect(message).toContain("— Different Time Workshop");
    expect(message).toContain("— Lone Workshop");
  });

  it("returns nothing when the window is empty, so cron posts no message", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-channel-digest')\n" +
          "print(json.dumps(m.build_message([], AoEClock.resolve('2026-08-04'), 45)))",
      ),
    ).toBeNull();
  });
});

describe("deadline reminder cadence", () => {
  it("nudges only confirmed rows, so a fuzzy workshop match never DMs on its own", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-reminders')\n" +
          "matches = {'ongoing': [{'title': 'A', 'confirmed': True}, {'title': 'B'}], " +
          "'ready': [{'title': 'C', 'confirmed': True}, {'title': 'D', 'confirmed': False}]}\n" +
          "print(json.dumps([p['title'] for p in m.confirmed_papers(matches)]))",
      ),
    ).toEqual(["A", "C"]);
  });

  // Steps are measured from the deadline instant (AoE + 12h), so T-N lands N days
  // before Aug 30 UTC — one day later than naive arithmetic on the Aug 29 AoE date.
  it("fires one cadence step per day and stays silent in between", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-reminders')\n" +
          "paper = {'deadline_aoe': '2026-08-29 23:59:59'}\n" +
          "out = {d: m.due_cadence_step(paper, AoEClock.resolve(d)) " +
          "for d in ['2026-07-31', '2026-08-15', '2026-08-22', '2026-08-23', " +
          "'2026-08-29', '2026-08-30']}\n" +
          "print(json.dumps(out))",
      ),
    ).toEqual({
      "2026-07-31": 30,
      "2026-08-15": 15,
      "2026-08-22": null,
      "2026-08-23": 7,
      "2026-08-29": 1,
      "2026-08-30": null,
    });
  });

  it("maps a venue group to its template action and falls back for unknown groups", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-reminders')\n" +
          "print(json.dumps([m.action_key_for({'venue_group': 'NeurIPS 2026 Workshops'}), " +
          "m.action_key_for({'venue_group': 'Brand New 2027 Workshops'}), " +
          "m.action_key_for({'venue_group': 'Some New Venue'}), m.action_key_for({})]))",
      ),
      // Any "<venue> Workshops" group reaches the one venue-agnostic workshop template, so a new
      // series needs a dataset row rather than a code edit.
    ).toEqual(["workshop", "workshop", "emnlp_commitment", "emnlp_commitment"]);
  });
});

// The sweep used to re-read every venue on every run, which is what earns a 429 from OpenReview
// partway through and silently truncates the board.
describe("sweep cadence", () => {
  const clock = (now: string) =>
    `AoEClock(__import__("datetime").datetime.fromisoformat(${JSON.stringify(now)}))`;

  it("re-reads a workshop daily inside three days, weekly otherwise, conferences fortnightly", () => {
    const result = runPython(
      [
        `c = ${clock("2026-08-27T12:00:00+00:00")}`,
        "print(json.dumps({",
        "  'workshop_tomorrow': sweep_interval_days(c, 'workshop', '2026-08-28 23:59:59'),",
        "  'workshop_two_days': sweep_interval_days(c, 'workshop', '2026-08-29 23:59:59'),",
        "  'workshop_exactly_three_days': sweep_interval_days(c, 'workshop', '2026-08-30 23:59:59'),",
        "  'workshop_four_days': sweep_interval_days(c, 'workshop', '2026-08-31 23:59:59'),",
        "  'workshop_far': sweep_interval_days(c, 'workshop', '2026-12-01 23:59:59'),",
        "  'workshop_passed': sweep_interval_days(c, 'workshop', '2026-08-01 23:59:59'),",
        "  'conference_tomorrow': sweep_interval_days(c, 'main_conference', '2026-08-28 23:59:59'),",
        "  'arr_far': sweep_interval_days(c, 'arr_direct_submission', '2026-12-01 23:59:59'),",
        "}))",
      ].join("\n"),
    );
    expect(result).toEqual({
      workshop_tomorrow: 1,
      workshop_two_days: 1,
      // Three days is inside the window, not the first day outside it.
      workshop_exactly_three_days: 1,
      workshop_four_days: 7,
      workshop_far: 7,
      // A passed deadline cannot move, so it drops below even the weekly cadence.
      workshop_passed: 14,
      // Conferences are fortnightly however close they are.
      conference_tomorrow: 14,
      arr_far: 14,
    });
  });

  it("decides due-ness from the last recorded read", () => {
    const result = runPython(
      [
        `c = ${clock("2026-08-27T12:00:00+00:00")}`,
        "print(json.dumps({",
        "  'imminent_checked_today': is_sweep_due(c, 'workshop', '2026-08-28 23:59:59', '2026-08-27T00:00:00Z'),",
        "  'imminent_checked_yesterday': is_sweep_due(c, 'workshop', '2026-08-28 23:59:59', '2026-08-26T00:00:00Z'),",
        "  'far_checked_two_days_ago': is_sweep_due(c, 'workshop', '2026-12-01 23:59:59', '2026-08-25T00:00:00Z'),",
        "  'far_checked_a_week_ago': is_sweep_due(c, 'workshop', '2026-12-01 23:59:59', '2026-08-20T00:00:00Z'),",
        "  'conference_checked_a_week_ago': is_sweep_due(c, 'main_conference', '2026-12-01 23:59:59', '2026-08-20T00:00:00Z'),",
        "}))",
      ].join("\n"),
    );
    expect(result).toEqual({
      imminent_checked_today: false,
      imminent_checked_yesterday: true,
      far_checked_two_days_ago: false,
      // A workshop further out is weekly now, so a week-old read is due again.
      far_checked_a_week_ago: true,
      conference_checked_a_week_ago: false,
    });
  });

  // A venue that never refreshes again is a worse failure than one refreshed too often.
  it("treats a missing, unparseable or future stamp as due", () => {
    const result = runPython(
      [
        `c = ${clock("2026-08-27T12:00:00+00:00")}`,
        "print(json.dumps({",
        "  'never': is_sweep_due(c, 'workshop', '2026-12-01 23:59:59', ''),",
        "  'none': is_sweep_due(c, 'workshop', '2026-12-01 23:59:59', None),",
        "  'garbage': is_sweep_due(c, 'workshop', '2026-12-01 23:59:59', 'not-a-date'),",
        "  'future': is_sweep_due(c, 'workshop', '2026-12-01 23:59:59', '2027-01-01T00:00:00Z'),",
        "  'bad_deadline': is_sweep_due(c, 'workshop', 'nonsense', '2026-08-26T00:00:00Z'),",
        "}))",
      ].join("\n"),
    );
    expect(result).toEqual({
      never: true,
      none: true,
      garbage: true,
      future: true,
      // An unparseable deadline falls back to the fortnightly interval, so one day old is not due.
      bad_deadline: false,
    });
  });
});
