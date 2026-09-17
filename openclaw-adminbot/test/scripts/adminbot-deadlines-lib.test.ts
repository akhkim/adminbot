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
    path.join(directory, "deadlines.json"),
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

describe("deadline calendar", () => {
  const setup = `
import os
from unittest.mock import patch
from types import SimpleNamespace
os.environ['ADMINBOT_DEADLINE_CALENDAR_ID'] = 'calendar@example.test'
os.environ['GOG_ACCOUNT'] = 'bot@example.test'
m = load('adminbot-deadline-calendar')
item = {'id': 'test-venue', 'name': 'Test Venue', 'deadline_aoe': '2026-09-30 23:59:59'}
`;

  it("ends a one-hour event at the actual AoE cutoff, including year rollover", () => {
    expect(
      runPython(`${setup}
item['deadline_aoe'] = '2026-12-31 23:59:59'
event = m.build_event(item)
print(json.dumps([event['start'], event['end'], event['description']]))`),
    ).toEqual([
      "2027-01-01T10:59:59+00:00",
      "2027-01-01T11:59:59+00:00",
      expect.stringContaining("Deadline: 2026-12-31 23:59:59 AoE"),
    ]);
  });

  it("converts an existing all-day event and updates the same ID on repeat", () => {
    const calls = runPython(`${setup}
calls = []
def gog(args, check=True):
    calls.append(args)
    return SimpleNamespace(returncode=0, stdout=json.dumps({'events': [
        {'id': 'existing-event', 'description': m.marker_for(item['id'])}
    ]}))
with patch.object(m.DeadlineDataset, 'venues', return_value=[item]), \
     patch.object(m, 'gog', side_effect=gog), \
     patch.dict(os.environ, {'ADMINBOT_DEADLINE_NOW': '2026-10-01T10:00:00+00:00'}), \
     patch.object(sys, 'argv', ['calendar', '--send']):
    m.main()
    m.main()
print(json.dumps(calls))`) as string[][];
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual([
      "calendar",
      "events",
      "calendar@example.test",
      "--from",
      "2026-09-29",
      "--to",
      "2026-10-03",
      "--max",
      "2500",
      "--json",
    ]);
    expect(calls[1].slice(0, 4)).toEqual([
      "calendar",
      "update",
      "calendar@example.test",
      "existing-event",
    ]);
    expect(calls[1].slice(-5)).toEqual([
      "--from",
      "2026-10-01T10:59:59+00:00",
      "--to",
      "2026-10-01T11:59:59+00:00",
      "--all-day=false",
    ]);
    expect(calls[3]).toEqual(calls[1]);
  });

  it("creates timed events, previews without Google calls, and skips expired deadlines", () => {
    expect(
      runPython(`${setup}
with patch.object(m.DeadlineDataset, 'venues', return_value=[item]), \
     patch.object(m, 'gog', return_value=SimpleNamespace(returncode=0, stdout='[]')) as gog, \
     patch.dict(os.environ, {'ADMINBOT_DEADLINE_NOW': '2026-10-01T10:00:00+00:00'}):
    with patch.object(sys, 'argv', ['calendar']):
        m.main()
    preview_calls = gog.call_count
    with patch.object(sys, 'argv', ['calendar', '--send']):
        m.main()
        create = gog.call_args.args[0]
        gog.reset_mock()
        with patch.dict(os.environ, {'ADMINBOT_DEADLINE_NOW': '2026-10-01T12:00:00+00:00'}):
            m.main()
    print(json.dumps([preview_calls, create[:2], create[-1], gog.call_count]))`),
    ).toEqual([0, ["calendar", "create"], "--all-day=false", 0]);
  });
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
          "m._openreview_submission_deadlines = lambda group_ids, include_expired=False, metadata=None: {group_ids[0]: '2035-01-03 23:59:59'}\n" +
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
          "m._openreview_submission_deadlines = lambda group_ids, include_expired=False, metadata=None: {}\n" +
          "source = {'parent': 'TEST/2035/Workshop', 'id_prefix': 'test2035_ws_', 'deadline_aoe': '', 'notification_aoe': '', 'family': 'ACL', 'group': 'TEST 2035 Workshops'}\n" +
          "previous = {'test2035_ws_Example': {'deadline_aoe': '2035-01-02 23:59:59', 'source_checked_at': '2034-12-01T00:00:00Z'}}\n" +
          "item = m.fetch_workshop_source(source, previous)[0]\n" +
          "print(json.dumps([item['_source_observed'], item['source_checked_at']]))",
      ),
    ).toEqual([false, "2034-12-01T00:00:00Z"]);
  });

  it("retains discovered groups with an explicit final-paper date", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "m._openreview_get = lambda *args, **kwargs: {'groups': [{'id': 'TEST/2035/Workshop/Example', 'content': {'title': {'value': 'Example'}, 'date': {'value': 'Abstract Registration: Jan 01 2035 11:00PM UTC-0, Submission Deadline: Jan 02 2035 11:00PM UTC-0'}}}]}\n" +
          "m._openreview_submission_deadlines = lambda group_ids, include_expired=False, metadata=None: {}\n" +
          "source = {'parent': 'TEST/2035/Workshop', 'id_prefix': 'test2035_ws_', 'deadline_aoe': '', 'notification_aoe': '', 'family': 'ACL', 'year': 2035, 'group': 'TEST 2035 Workshops'}\n" +
          "print(json.dumps([x['deadline_aoe'] for x in m.fetch_workshop_source(source, [])]))",
      ),
    ).toEqual(["2035-01-02 11:00:00"]);
  });

  it("does not substitute an ARR paper-cycle date for a commitment deadline", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "gid = 'EMNLP/2035/Workshop/MINT_ARR_Commitment'\n" +
          "m._openreview_get = lambda *args, **kwargs: {'groups': [{'id': gid, 'content': {'title': {'value': 'MINT commitment'}, 'date': {'value': 'Abstract Registration: Jan 01 2035 11:00PM UTC-0, Submission Deadline: Jan 02 2035 11:00PM UTC-0'}}}]}\n" +
          "m._openreview_submission_deadlines = lambda group_ids, include_expired=False, metadata=None: {}\n" +
          "source = {'parent': 'EMNLP/2035/Workshop', 'id_prefix': 'emnlp2035_ws_', 'deadline_aoe': '', 'notification_aoe': '', 'family': 'EMNLP', 'year': 2035, 'group': 'EMNLP 2035 Workshops'}\n" +
          "previous = {'emnlp2035_ws_MINT_ARR_Commitment': {'deadline_aoe': '2035-02-01 23:59:00'}}\n" +
          "item = m.fetch_workshop_source(source, previous)[0]\n" +
          "print(json.dumps([item['deadline_aoe'], item['_group_final_deadline']]))",
      ),
    ).toEqual(["2035-02-01 23:59:00", ""]);
  });

  it("uses an explicit final-paper workflow date instead of abstract registration", () => {
    expect(
      runPython(
        "from adminbot_workshop_deadlines import group_final_submission_deadline\n" +
          "content = {'date': {'value': 'Abstract Registration: Sep 05 2026 11:00PM UTC-0, Submission Deadline: Sep 13 2026 11:59AM UTC-0'}}\n" +
          "print(json.dumps(group_final_submission_deadline(content)))",
      ),
    ).toBe("2026-09-12 23:59:00");
  });

  it("keeps a matched portal deadline when a CFP announces a different time", () => {
    const html =
      "<p>All deadlines are 11:59 PM Anywhere on Earth (AoE).</p>" +
      "<p>Paper submission deadline <s>August 29, 2026</s> September 5, 2026 (extended).</p>";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates\n" +
          `html = ${JSON.stringify(html)}\n` +
          "candidates, _ = deadline_candidates_from_html(html, 'https://workshop.example/', 2026)\n" +
          "result = reconcile_deadline_candidates(candidates, '2026-09-05 09:00:00', 'https://openreview.net/group?id=Example', 2026)\n" +
          "print(json.dumps([result['deadline_aoe'], result['deadline_extended'], result['source_revisions']]))",
      ),
    ).toEqual(["2026-09-05 09:00:00", true, []]);
  });

  it("does not replace an invitation cutoff with a different stage", () => {
    const html =
      "<table><tr><td>Abstract Registration Deadline</td><td>2026/09/05 23:00 GMT</td></tr>" +
      "<tr><td>Paper Submission Deadline</td><td>2026/09/12 23:00 GMT</td></tr></table>";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates\n" +
          `html = ${JSON.stringify(html)}\n` +
          "candidates, _ = deadline_candidates_from_html(html, 'https://workshop.example/call/', 2026)\n" +
          "result = reconcile_deadline_candidates(candidates, '2026-09-05 11:00:00', 'https://openreview.net/group?id=Example', 2026)\n" +
          "print(json.dumps(result['deadline_aoe']))",
      ),
    ).toBe("2026-09-05 11:00:00");
  });

  it("does not treat a submission-opening date or a bare schedule update as an extension", () => {
    const markdown =
      "Paper submissions are now due September 6, 2026 (AoE).\n" +
      "Paper submission opens: July 25, 2026.\n" +
      "Paper submission deadline: September 6, 2026 (AoE).";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_text, reconcile_deadline_candidates\n" +
          `text = ${JSON.stringify(markdown)}\n` +
          "candidates = deadline_candidates_from_text(text, 'https://workshop.example/', 2026)\n" +
          "result = reconcile_deadline_candidates(candidates, '2026-09-06 23:59:00', 'https://openreview.net/group?id=Example', 2026)\n" +
          "print(json.dumps([result['deadline_aoe'], result['deadline_extended'], result['source_revisions']]))",
      ),
    ).toEqual(["2026-09-06 23:59:00", false, []]);
  });

  it("keeps the exact portal cutoff when an extended website date omits its time zone", () => {
    const html =
      "<p>Deadline extended: the paper submission deadline is now September 8, 2026.</p>";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates\n" +
          `html = ${JSON.stringify(html)}\n` +
          "candidates, _ = deadline_candidates_from_html(html, 'https://workshop.example/', 2026)\n" +
          "result = reconcile_deadline_candidates(candidates, '2026-09-07 16:00:00', 'https://openreview.net/group?id=Example', 2026)\n" +
          "print(json.dumps([result['deadline_aoe'], result['deadline_source_status'], result['deadline_extended']]))",
      ),
    ).toEqual(["2026-09-07 16:00:00", "official_date_conflicts_with_openreview", true]);
  });

  it("uses the requested shared-site track and ignores another stage's extension", () => {
    const shared =
      "<p>Regular Submission Deadline: September 7, 2026 AoE.</p>" +
      "<p>NeurIPS Fast-Track Deadline: September 25, 2026 AoE.</p>";
    const unrelated =
      "<p>All deadlines are 23:59 AoE.</p>" +
      "<p>Abstract submission deadline: <s>August 22, 2026</s> extended to August 29, 2026.</p>" +
      "<p>Submission deadline for workshop contributions: August 29, 2026.</p>";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates\n" +
          `shared = ${JSON.stringify(shared)}\n` +
          `unrelated = ${JSON.stringify(unrelated)}\n` +
          "shared_candidates, _ = deadline_candidates_from_html(shared, 'https://workshop.example/', 2026)\n" +
          "fast = reconcile_deadline_candidates(shared_candidates, '', 'https://openreview.net/group?id=Fast', 2026, target_hint='Fast_Track')\n" +
          "unrelated_candidates, _ = deadline_candidates_from_html(unrelated, 'https://workshop.example/', 2026)\n" +
          "paper = reconcile_deadline_candidates(unrelated_candidates, '2026-08-30 00:00:00', 'https://openreview.net/group?id=Paper', 2026)\n" +
          "print(json.dumps([fast['deadline_aoe'], fast['deadline_time_precision'], fast['deadline_at'], paper['deadline_extended'], paper['source_revisions']]))",
      ),
    ).toEqual(["2026-09-25 00:00:00", "date_only", "", false, []]);
  });

  it("retains the supplied matched portal cutoff over a different CFP route", () => {
    const html =
      "<p>All deadlines are 11:59 PM AoE.</p>" +
      "<p>ARR paper submission deadline May 25, 2026</p>" +
      "<p>Direct paper submission deadline <s>July 8, 2026</s> July 22, 2026</p>" +
      "<p>Pre-reviewed ARR commitment deadline <s>August 24, 2026</s> August 31, 2026</p>";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates\n" +
          `html = ${JSON.stringify(html)}\n` +
          "candidates, _ = deadline_candidates_from_html(html, 'https://workshop.example/', 2026)\n" +
          "result = reconcile_deadline_candidates(candidates, '2026-05-25 23:59:00', 'https://openreview.net/group?id=Example', 2026, target_hint='MINT_ARR_Commitment')\n" +
          "print(json.dumps([result['deadline_aoe'], result['source_revisions']]))",
      ),
    ).toEqual(["2026-05-25 23:59:00", []]);
  });

  it("retains a route cutoff when a page only advertises another route", () => {
    const html = "<p>Direct submission deadline extended to August 10, 2026 at 12:59 PM UTC.</p>";
    expect(
      runPython(
        "from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates\n" +
          `html = ${JSON.stringify(html)}\n` +
          "candidates, _ = deadline_candidates_from_html(html, 'https://workshop.example/', 2026)\n" +
          "result = reconcile_deadline_candidates(candidates, '2026-09-15 11:59:00', 'https://openreview.net/group?id=Shared_Task', 2026, target_hint='DocInsights_Shared_Task')\n" +
          "print(json.dumps([result['deadline_aoe'], result['deadline_source_status'], result['deadline_extended']]))",
      ),
    ).toEqual(["2026-09-15 11:59:00", "openreview_only", false]);
  });

  it("derives GitHub Pages repositories without a workshop-specific table", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "print(json.dumps([m._github_pages_repository('https://example.github.io/'), m._github_pages_repository('https://owner.github.io/project/cfp/'), m._github_pages_repository('https://workshop.example/')]))",
      ),
    ).toEqual([
      ["example", "example.github.io", "index.html"],
      ["owner", "project", "cfp/index.html"],
      null,
    ]);
  });

  it("does not cross conference editions when a workshop reuses its site root", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "old = '<title>AI4GOOD @ ICML 2026</title><h1>Trustworthy AI for Good @ ICML 2026</h1><p>Same as NeurIPS policy.</p>'\n" +
          "current = '<title>AI4GOOD @ NeurIPS 2026</title><h1>Trustworthy AI for Good @ NeurIPS 2026</h1>'\n" +
          "print(json.dumps([m._github_history_document_matches_target(old, 'AI4GOOD @ NeurIPS 2026', 2026), m._github_history_document_matches_target(current, 'AI4GOOD @ NeurIPS 2026', 2026)]))",
      ),
    ).toEqual([false, true]);
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
  it("can load a clean committed baseline for deterministic recovery", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          'answers = iter([\'/repo\', \'{"history_version": 7, "count": 12, "items": []}\'])\n' +
          "m._git_output = lambda *args, **kwargs: next(answers)\n" +
          "m.HERE = '/repo/scripts'\n" +
          "m.OUT = '/repo/data/deadlines.json'\n" +
          "baseline = m._load_previous_document('HEAD')\n" +
          "print(json.dumps([baseline['history_version'], baseline['count']]))",
      ),
    ).toEqual([7, 12]);
  });

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

  it("does not create a visible revision for a seconds-only source correction", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "old = {'id':'example','entry_type':'main_conference','deadline_aoe':'2026-09-15 23:59:32','deadline_label':'paper','link':'https://example.test','revisions':[{'observed_at':'2026-08-01T00:00:00Z','deadline_aoe':'2026-09-15 23:59:32','deadline_label':'paper','link':'https://example.test'}]}\n" +
          "new = dict(old, deadline_aoe='2026-09-15 23:59:00')\n" +
          "item = m.merge_history(new, old)\n" +
          "print(json.dumps([len(item['revisions']), item['revisions'][0]['deadline_aoe']]))",
      ),
    ).toEqual([1, "2026-09-15 23:59:32"]);
  });

  it("merges recovered source history idempotently in old-to-new order", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-collect')\n" +
          "old = {'id':'example','entry_type':'workshop','deadline_aoe':'2026-09-01 23:59:00','deadline_label':'submission','link':'https://example.test','revisions':[{'observed_at':'2026-09-01T00:00:00Z','deadline_aoe':'2026-09-01 23:59:00','deadline_label':'submission','link':'https://example.test'}]}\n" +
          "source = [dict(observed_at='2026-08-20T00:00:00Z', deadline_aoe='2026-08-29 23:59:00', deadline_label='submission', link='https://source.test/old'), dict(observed_at='2026-08-25T00:00:00Z', deadline_aoe='2026-09-01 23:59:00', deadline_label='submission', link='https://source.test/new')]\n" +
          "first = m.merge_history(dict(old, _source_revisions=source, deadline_history_status='source_history'), old)\n" +
          "second = m.merge_history(dict(first, _source_revisions=source), first)\n" +
          "print(json.dumps([[r['deadline_aoe'] for r in first['revisions']], [r['deadline_aoe'] for r in second['revisions']]]))",
      ),
    ).toEqual([
      ["2026-08-29 23:59:00", "2026-09-01 23:59:00"],
      ["2026-08-29 23:59:00", "2026-09-01 23:59:00"],
    ]);
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

  it("re-reads near deadlines daily for both workshops and conferences", () => {
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
      workshop_four_days: 1,
      workshop_far: 7,
      // Well past the post-deadline watch window, workshops return to weekly checks.
      workshop_passed: 7,
      // Conferences are fortnightly however close they are.
      conference_tomorrow: 1,
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

describe("deadline stage preservation", () => {
  it("keeps abstract registration and full paper as distinct rows", () => {
    expect(
      runPython(`
from adminbot_workshop_deadlines import split_workshop_milestones
item = {'id': 'example', 'name': 'Example', 'submission_type': 'direct', '_openreview_deadline': '2035-01-01 11:00:00', '_group_final_deadline': '2035-01-02 11:00:00', '_group_final_evidence': 'Abstract Registration: Jan 01 2035 11:00PM UTC-0, Submission Deadline: Jan 02 2035 11:00PM UTC-0'}
rows = split_workshop_milestones(item, [], 2035)
print(json.dumps([[r['id'], r['deadline_label'], r['deadline_aoe'], r['_openreview_deadline']] for r in rows]))
`),
    ).toEqual([
      ["example", "full paper", "2035-01-02 11:00:00", ""],
      ["example_abstract", "abstract registration", "2035-01-01 11:00:00", "2035-01-01 11:00:00"],
    ]);
  });
  it("continues daily checking after a deadline has just passed", () => {
    expect(
      runPython(
        "print(json.dumps(sweep_interval_days(AoEClock.resolve('2026-09-11T14:00:00Z'), 'workshop', '2026-09-10 23:59:59')))",
      ),
    ).toBe(1);
  });
});

it("does not borrow paper stages for an unmatched competition portal", () => {
  expect(
    runPython(`
from adminbot_workshop_deadlines import split_workshop_milestones, deadline_candidates_from_text
item = {'id':'competition','name':'Example competition','deadline_aoe':'2035-11-08 23:00:00','_openreview_deadline':'2035-11-08 23:00:00'}
candidates = deadline_candidates_from_text('Abstract submission deadline: September 11, 2035 AoE. Paper submission deadline: September 13, 2035 AoE.', 'https://example.org/', 2035)
rows = split_workshop_milestones(item, candidates, 2035)
print(json.dumps([[row['id'], row['deadline_aoe']] for row in rows]))
`),
  ).toEqual([["competition", "2035-11-08 23:00:00"]]);
});

it("preserves invitation expiry separately without using it as the due date", () => {
  expect(
    runPython(`
m = load('adminbot-deadline-collect')
m._openreview_get = lambda *args, **kwargs: {'invitations':[{'id':'Example/-/Submission','duedate':2000000000000,'expdate':2000001800000}]}
metadata = {}
dates = m._openreview_submission_deadlines(['Example'], include_expired=True, metadata=metadata)
print(json.dumps([dates['Example'] == metadata['Example']['duedate_aoe'], metadata['Example']['duedate_aoe'] != metadata['Example']['expdate_aoe']]))
`),
  ).toEqual([true, true]);
});

it("binds both stages to their declared OpenReview invitations", () => {
  expect(
    runPython(`
from adminbot_workshop_deadlines import split_workshop_milestones
item = {'id':'example','name':'Example','_openreview_deadline':'2035-09-11 23:59:00','_full_submission_deadline':'2035-09-13 23:59:00'}
rows = split_workshop_milestones(item, [], 2035)
print(json.dumps([[row['id'], row['_openreview_deadline']] for row in rows]))
`),
  ).toEqual([
    ["example", "2035-09-13 23:59:00"],
    ["example_abstract", "2035-09-11 23:59:00"],
  ]);
});

it("keeps unavailable configured conference sources uncertain without advancing the check date", () => {
  expect(
    runPython(`
m = load('adminbot-deadline-collect')
m.fetch_invitation_observations = lambda ids: {}
m._fetch_html = lambda url: (_ for _ in ()).throw(OSError('unavailable'))
old = {'id':'iclr2027_paper','deadline_aoe':'2026-09-25 23:59:00','source_checked_at':'2026-09-01T00:00:00Z'}
row = m.refresh_configured_conferences([dict(old)], {old['id']:old}, AoEClock.resolve('2026-09-11'), True)[0]
print(json.dumps([row['deadline_aoe'], row['source_checked_at'], row['_source_observed'], row['deadline_source_status']]))
`),
  ).toEqual(["2026-09-25 23:59:00", "2026-09-01T00:00:00Z", false, "source_unavailable"]);
});

it("refreshes the named commitment row without borrowing submission or notification dates", () => {
  expect(
    runPython(`
from adminbot_conference_deadlines import conference_table_deadline
html = '<table><tr><td>ARR submission deadline</td><td>October 12, 2026</td></tr><tr><td>NAACL commitment deadline</td><td>December 23, 2026</td></tr><tr><td>Notification</td><td>February 10, 2027</td></tr></table>'
print(json.dumps([conference_table_deadline(html, 'NAACL commitment deadline', 2026)[0], conference_table_deadline(html, 'Missing deadline', 2026), conference_table_deadline(html + html, 'NAACL commitment deadline', 2026)]))
`),
  ).toEqual(["2026-12-23", null, null]);
});

it("does not invent a tutorial abstract stage from a shared paper CFP", () => {
  expect(
    runPython(`
from adminbot_workshop_deadlines import split_workshop_milestones, deadline_candidates_from_text
item = {'id':'tutorial','name':'Tutorials track','deadline_aoe':'2035-09-11 23:59:00','_openreview_deadline':'2035-09-11 23:59:00'}
candidates = deadline_candidates_from_text('Abstract submission deadline: September 11, 2035 AoE. Paper submission deadline: September 13, 2035 AoE.', 'https://example.org/', 2035)
print(json.dumps([row['id'] for row in split_workshop_milestones(item, candidates, 2035)]))
`),
  ).toEqual(["tutorial"]);
});

describe("deadline time precision", () => {
  it("retains an exact UTC instant without changing its seconds", () => {
    expect(
      runPython(`from adminbot_deadline_time import timing_fields
print(json.dumps(timing_fields('2035-02-01 23:59:59')))`),
    ).toMatchObject({
      deadline_at: "2035-02-02T11:59:59Z",
      deadline_planning_at: "2035-02-02T11:59:59Z",
      deadline_time_precision: "exact",
    });
  });

  it("uses the start of the stated day in its known zone, or UTC+14 when unknown", () => {
    expect(
      runPython(`from adminbot_deadline_time import timing_fields
print(json.dumps([timing_fields('2035-02-01', date_only=True, timezone=zone) for zone in ['AoE', 'UTC', '']]))`),
    ).toMatchObject([
      {
        deadline_date: "2035-02-01",
        deadline_at: "",
        deadline_planning_at: "2035-02-01T12:00:00Z",
      },
      {
        deadline_date: "2035-02-01",
        deadline_at: "",
        deadline_planning_at: "2035-02-01T00:00:00Z",
      },
      {
        deadline_date: "2035-02-01",
        deadline_at: "",
        deadline_planning_at: "2035-01-31T10:00:00Z",
      },
    ]);
  });

  it("keeps date-only abstract and paper stages separate", () => {
    expect(
      runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_html, split_workshop_milestones, reconcile_deadline_candidates, _candidate_is_abstract
html = '<p>Abstract registration deadline: September 11, 2035 AoE.</p><p>Paper submission deadline: September 13, 2035 AoE.</p>'
candidates, _ = deadline_candidates_from_html(html, 'https://example.test', 2035)
rows = split_workshop_milestones({'id':'example','name':'Example'}, candidates, 2035)
results = [reconcile_deadline_candidates([c for c in candidates if _candidate_is_abstract(c) == (row['_stage'] == 'abstract')], row['_openreview_deadline'], '', 2035, row['_group_final_deadline'], target_hint=row['_stage']) for row in rows]
print(json.dumps([[row['id'], result['deadline_date'], result['deadline_at'], result['deadline_time_precision']] for row, result in zip(rows, results)]))`),
    ).toEqual([
      ["example", "2035-09-13", "", "date_only"],
      ["example_abstract", "2035-09-11", "", "date_only"],
    ]);
  });

  it("does not invent a time for a conference table date", () => {
    expect(
      runPython(`from adminbot_conference_deadlines import refresh_conference_tables
item = {'id':'naacl2027_commitment','deadline_aoe':'2026-11-15 23:59:00'}
refresh_conference_tables([item], {}, AoEClock.resolve('2026-09-01T00:00:00Z'), True, lambda url: (url, '<table><tr><td>NAACL commitment deadline</td><td>November 16, 2026</td></tr></table>'), lambda: '2026-09-01T00:00:00Z')
print(json.dumps(item))`),
    ).toMatchObject({
      deadline_date: "2026-11-16",
      deadline_at: "",
      deadline_time_precision: "date_only",
      deadline_timezone: "",
    });
  });

  it("does not escalate a passed planning cutoff as a missed submission", () => {
    expect(
      runPython(`from adminbot_deadline_time import timing_fields
m = load('adminbot-deadline-reminders')
item = dict(id='example', **timing_fields('2035-02-01', date_only=True))
class Dataset:
    def venues(self): return [item]
    def matches(self): return {'ongoing': [{'confirmed': True, 'title': 'Example', 'deadline_id': 'example'}]}
    def templates(self): return {}
class Notifier:
    mode = "test"
    def __init__(self, **kw): pass
    def send_to_user(self, *args, **kw): raise AssertionError('unexpected notification')
m.DeadlineDataset = Dataset
m.SlackNotifier = Notifier
m.load_roster = lambda: {}
m.openreview_submitted_titles = lambda: set()
sys.argv = ['reminders', '--now', '2035-02-02T00:00:00Z']
m.main()
print(json.dumps(True))`),
    ).toBe(true);
  });
});

it("does not preserve an invented end-of-day time from cached date-only evidence", () => {
  expect(
    runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_text, reconcile_deadline_candidates
candidates = deadline_candidates_from_text('Paper submission deadline: September 25, 2035 AoE.', 'https://example.test', 2035)
for candidate in candidates: candidate['stamp'] = candidate['date'] + ' 23:59:00'
result = reconcile_deadline_candidates(candidates, '', '', 2035)
print(json.dumps([result['deadline_at'], result['deadline_time_precision'], result['deadline_planning_at']]))`),
  ).toEqual(["", "date_only", "2035-09-25T12:00:00Z"]);
});

it("does not call learning the exact time an extension of a planning cutoff", () => {
  expect(
    runPython(`from adminbot_deadline_time import timing_fields
m = load('adminbot-deadline-collect')
old = m.merge_history(dict(id='example', name='Example', **timing_fields('2035-02-01', date_only=True, timezone='AoE')))
current = m.merge_history(dict(id='example', name='Example', **timing_fields('2035-02-01 23:59:00')), old)
print(json.dumps([len(current['revisions']), current['deadline_extended']]))`),
  ).toEqual([2, false]);
});

it("retains original UTC and AoE source zones through candidate normalization", () => {
  expect(
    runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_text, reconcile_deadline_candidates
results = []
for zone in ['UTC', 'AoE']:
    candidates = deadline_candidates_from_text('Paper submission deadline: September 25, 2035 23:59 ' + zone, 'https://example.org/cfp', 2035)
    result = reconcile_deadline_candidates(candidates, '', '', 2035)
    results.append([result['deadline_timezone'], result['deadline_at']])
print(json.dumps(results))`),
  ).toEqual([
    ["UTC", "2035-09-25T23:59:00Z"],
    ["AoE", "2035-09-26T11:59:00Z"],
  ]);
});

it("does not invent an original timezone for normalized legacy timestamps", () => {
  expect(
    runPython(`from adminbot_deadline_time import timing_fields
print(json.dumps(timing_fields('2035-09-25 23:59:00')['deadline_timezone']))`),
  ).toBe("");
});

it("keeps the source calendar day when normalizing an early UTC deadline", () => {
  expect(
    runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_text, reconcile_deadline_candidates
candidates = deadline_candidates_from_text('Paper submission deadline: September 25, 2035 01:00 UTC', 'https://example.org/cfp', 2035)
result = reconcile_deadline_candidates(candidates, '', '', 2035)
m = load('adminbot-deadline-collect')
result.update(id='example', name='Example', venue_type='workshop', venue_group='Example 2035', deadline_label='submission')
m.classify(result)
merged = m.merge_history(result)
print(json.dumps([result['deadline_date'], result['deadline_timezone'], result['deadline_at'], merged['revisions'][-1]['deadline_timezone']]))`),
  ).toEqual(["2035-09-25", "UTC", "2035-09-25T01:00:00Z", "UTC"]);
});

describe("abstract registration evidence", () => {
  it.each([
    ["Abstract registration is mandatory. Date TBA.", "required"],
    ["Abstract registration deadline: to be announced.", "required"],
    ["No separate abstract registration is required.", "not_required"],
    ["Abstract registration is optional.", "not_required"],
    ["Submit a paper by September 25, 2035.", "unknown"],
    ["If you join the demo track, abstract registration is required.", "unknown"],
    ["2034: Abstract registration is required.", "unknown"],
    [
      "[OLD]Abstract registration is required.[/OLD] No abstract registration is required.",
      "not_required",
    ],
    ["Abstract registration is required. Abstract registration is optional.", "unknown"],
  ])("classifies only explicit unambiguous requirements: %s", (text, expected) => {
    expect(
      runPython(`from adminbot_abstract_requirements import requirement_from_text
print(json.dumps(requirement_from_text(${JSON.stringify(text)}, 'https://example.org/cfp', 2035).get('abstract_requirement', 'unknown')))`),
    ).toBe(expected);
  });

  it("caches requirement evidence and preserves conflicts across homepage/CFP merging", () => {
    expect(
      runPython(`m = load('adminbot-deadline-collect')
a = m.workshop_profile_from_html('<p>Abstract registration is required.</p>', 'https://example.org', 2035)
b = m.workshop_profile_from_html('<p>No abstract registration is required.</p>', 'https://example.org/cfp', 2035)
merged = m._merge_workshop_profiles(a, b)
previous = dict(merged, website_deadline_candidates=[])
cached = m.cached_workshop_metadata(previous)[2]
print(json.dumps([cached['abstract_requirement'], cached['abstract_requirement_conflict']]))`),
    ).toEqual(["unknown", true]);
  });

  it("does not treat script content as an explicit registration policy", () => {
    expect(
      runPython(`m = load('adminbot-deadline-collect')
p = m.workshop_profile_from_html('<script>Abstract registration is required.</script><p>Call for papers</p>', 'https://example.org', 2035)
print(json.dumps(p.get('abstract_requirement', 'unknown')))`),
    ).toBe("unknown");
  });

  it("links only one current abstract in the same track and edition, and respects optional registration", () => {
    expect(
      runPython(`from adminbot_abstract_requirements import attach_abstract_requirements
abstract = dict(id='abstract', venue_id='example', venue_group='Example 2035', track='main', milestone='abstract', deadline_aoe='2035-09-20 00:00:00')
base = dict(id='paper', venue_id='example', venue_group='Example 2035', track='main', milestone='full_paper', deadline_aoe='2035-09-25 00:00:00')
results = []
for patch in [{}, {'track':'demo'}, {'venue_group':'Example 2036'}, {'abstract_requirement':'not_required'}, {'abstract_requirement_conflict':True}]:
    paper = dict(base, **patch)
    attach_abstract_requirements([paper, dict(abstract)])
    results.append(paper.get('abstract_deadline_id', ''))
    if not patch: assert 'abstract_requirement' not in paper
for change in [{'stale':True}, {'deadline_aoe':'2035-09-26 00:00:00'}]:
    paper = dict(base)
    attach_abstract_requirements([paper, dict(abstract, **change)])
    results.append(paper.get('abstract_deadline_id', ''))
print(json.dumps(results))`),
    ).toEqual(["abstract", "", "", "abstract", "abstract", "", ""]);
  });
});

describe("deadline output generation", () => {
  it("writes the dataset and all projections without requiring an HTML template", () => {
    expect(
      runPython(`
import tempfile
from pathlib import Path
m = load('adminbot-deadline-collect')
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    for folder in ['scripts', 'extensions/adminbot/src/workflows/deadlines/generated', 'ui/src/ui/adminbot/data', 'content']:
        (root / folder).mkdir(parents=True)
    m.HERE = str(root / 'scripts')
    m.OUT = str(root / 'content/deadlines.json')
    m.DEADLINES_DIR = str(root / 'content')
    m.write_outputs([dict(id='example', name='Example Workshop', venue_type='workshop', deadline_aoe='', venue_group='Example')])
    assert json.loads((root / 'content/deadlines.json').read_text())['items'][0]['id'] == 'example'
    print(json.dumps(sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())))
`),
    ).toEqual([
      "content/deadlines.json",
      "extensions/adminbot/src/workflows/deadlines/generated/dataset.ts",
      "ui/src/ui/adminbot/data/deadlines-summary.ts",
      "ui/src/ui/adminbot/data/deadlines.ts",
    ]);
  });
});

describe("deadline extraction evidence", () => {
  it("rejects reused pages from another edition and retains the reason", () => {
    expect(
      runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates
c, _ = deadline_candidates_from_html('<h1>Workshop 2034</h1><p>Paper submission deadline: September 10 at 23:59 AoE</p>', 'https://example.org', 2035)
r = reconcile_deadline_candidates(c, '2035-09-12 23:59:00', 'https://openreview.net/example', 2035)
print(json.dumps([r['deadline_aoe'], r['deadline_observations'][1]['decision']]))`),
    ).toEqual(["2035-09-12 23:59:00", "different_edition"]);
  });
  it("does not select crossed-out dates even when they match the portal", () => {
    expect(
      runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates
c, _ = deadline_candidates_from_html('<p>Paper submission deadline: <s>September 10 at 23:59 AoE</s></p><p>Paper submission deadline extended to September 17 at 23:59 AoE</p>', 'https://example.org', 2035)
r = reconcile_deadline_candidates(c, '2035-09-10 23:59:00', 'https://openreview.net/example', 2035)
print(json.dumps([r['deadline_aoe'], sorted(set(x['decision'] for x in r['deadline_observations']))]))`),
    ).toEqual([
      "2035-09-10 23:59:00",
      ["authoritative", "conflicts_with_portal", "historical_date"],
    ]);
  });
  it("keeps full-paper selection separate from abstract evidence", () => {
    expect(
      runPython(`from adminbot_workshop_deadlines import deadline_candidates_from_html, reconcile_deadline_candidates
c, _ = deadline_candidates_from_html('<p>Abstract registration deadline: September 10 at 23:59 AoE</p>', 'https://example.org', 2035)
r = reconcile_deadline_candidates(c, '', '', 2035, target_hint='Example full_paper')
print(json.dumps([r['deadline_aoe'], r['deadline_observations'][0]['decision']]))`),
    ).toEqual(["", "different_milestone"]);
  });
  it("retains asset URLs separately from the workshop page without network access", () => {
    expect(
      runPython(`m = load('adminbot-deadline-collect')
m._fetch_text_asset = lambda url: (url, 'Paper submission deadline: September 25 at 23:59 AoE')
p = m._profile_with_deadline_assets('<script src="/assets/cfp.js"></script>', 'https://example.org', 2035)
c = p['_deadline_candidates'][0]
print(json.dumps([c['source_url'], c['document_id'], c['extraction_kind']]))`),
    ).toEqual(["https://example.org", "https://example.org/assets/cfp.js", "script_asset"]);
  });
});

it("keeps extraction observations and their original check age on a skipped sweep", () => {
  expect(
    runPython(`m = load('adminbot-deadline-collect')
old = dict(id='example', name='Example', venue_type='workshop', deadline_aoe='2035-12-20 23:59:00', profile_extracted_at='2035-09-10T00:00:00Z', source_checked_at='2035-09-10T00:00:00Z', deadline_observations=[{'decision':'conflicts_with_portal'}])
rows = [dict(id='example', name='Example', venue_type='workshop', deadline_aoe=old['deadline_aoe'])]
m.enrich_workshop_sources(rows, {'example': old}, AoEClock.resolve('2035-09-11T00:00:00Z'))
print(json.dumps([rows[0]['deadline_observations'], rows[0]['source_checked_at']]))`),
  ).toEqual([[{ decision: "conflicts_with_portal" }], "2035-09-10T00:00:00Z"]);
});

it("keeps undated workshop discovery and uses the same id when the date appears", () => {
  expect(
    runPython(`m = load('adminbot-deadline-collect')
m._openreview_get = lambda *a, **kw: {'groups':[{'id':'TEST/2035/Workshop/Example','content':{'title':{'value':'Example'}}}]}
m._openreview_submission_deadlines = lambda *a, **kw: {}
m.fetch_invitation_observations = lambda ids: {}
source = dict(parent='TEST/2035/Workshop', id_prefix='test2035_ws_', deadline_aoe='', notification_aoe='', family='TEST', year=2035, group='TEST 2035 Workshops')
first = m.fetch_workshop_source(source)[0]
assert first['_source_observed'] and first['source_checked_at']
m._openreview_submission_deadlines = lambda *a, **kw: {'TEST/2035/Workshop/Example':'2035-09-25 23:59:00'}
second = m.fetch_workshop_source(source, {first['id']:first})[0]
print(json.dumps([first['id'], first['deadline_aoe'], second['id'], second['deadline_aoe']]))`),
  ).toEqual(["test2035_ws_Example", "", "test2035_ws_Example", "2035-09-25 23:59:00"]);
});

it("excludes undated venues from date-driven digests", () => {
  expect(
    runPython(`d = DeadlineDataset()
d.venues = lambda: [dict(id='unknown', name='Example', deadline_aoe='')]
c = AoEClock.resolve('2035-09-01')
print(json.dumps([d.upcoming(c,45), d.past(c)]))`),
  ).toEqual([[], []]);
});

it("does not remind or escalate an undated workshop match", () => {
  expect(
    runPython(`m = load('adminbot-deadline-reminders')
class Dataset:
 def venues(self): return [dict(id='example', deadline_aoe='')]
 def matches(self): return {'ongoing':[{'confirmed':True,'title':'Example','deadline_id':'example'}]}
 def templates(self): return {}
class Notifier:
 mode='test'
 def __init__(self, **kw): pass
 def send_to_user(self,*a,**kw): raise AssertionError('Unexpected reminder')
m.DeadlineDataset=Dataset
m.SlackNotifier=Notifier
m.load_roster=lambda: {}
m.openreview_submitted_titles=lambda: set()
sys.argv=['reminders','--now','2035-09-01']
m.main()
print(json.dumps(True))`),
  ).toBe(true);
});

it("does not call the first published date an extension of an unknown deadline", () => {
  expect(
    runPython(`m=load('adminbot-deadline-collect')
old=m.merge_history(m.classify(dict(id='example',name='Example',venue_type='workshop',venue_group='Example 2035 Workshops',track='workshop',deadline_aoe='',notification_aoe='',deadline_label='submission',link='https://example.org')))
new=m.merge_history(dict(old,deadline_aoe='2035-09-25 23:59:00'), old)
print(json.dumps([old['deadline_aoe'],old['deadline_id']==new['deadline_id'],new['deadline_extended']]))`),
  ).toEqual(["", true, false]);
});
