import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/aclrollingreview-dates.html", import.meta.url));

function run(body: string) {
  const out = execFileSync(
    "python3",
    [
      "-c",
      `
import json, sys
sys.path.insert(0, ${JSON.stringify(scripts)})
import adminbot_arr_dates as arr
import adminbot_conference_deadlines as conf
from adminbot_deadlines import AoEClock
html = open(${JSON.stringify(fixture)}).read()
clock = AoEClock.resolve('2026-11-23')
def go(page, items, previous=None):
    previous = previous or {}
    def fetch(url):
        if page is None:
            raise RuntimeError('page down')
        return url, page
    cycles, venues = conf.discover_arr_cycles(items, previous, clock, fetch)
    conf.refresh_arr_cycles(items, cycles, venues, lambda: '2026-11-23T00:00:00Z')
    return {item['id']: item for item in items}
${body}
`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("ARR dates page", () => {
  it("parses every cycle milestone and the author-response window", () => {
    const cycles = run(`print(json.dumps(arr.parse_arr_cycles(html)))`) as Array<any>;
    expect(cycles.map((c) => c.id)).toEqual([
      "arr_2026_march",
      "arr_2026_may",
      "arr_2026_august",
      "arr_2026_october",
    ]);
    const october = cycles.at(-1).milestones;
    expect(october).toMatchObject({
      submission: "2026-10-12",
      reviews_due: "2026-11-16",
      author_response: { starts: "2026-11-24", ends: "2026-11-30" },
      meta_reviews: "2026-12-17",
      cycle_end: "2026-12-20",
    });
  });

  it("rolls a cycle's later dates into the next year", () => {
    const page = `<table class="review-cycle-table"><tr><td>December 2026</td><td>December 14</td>
      <td>December 16</td><td>January 20</td><td>January 28-February 3</td><td>February 20</td>
      <td>February 23</td></tr></table>`;
    const [cycle] = run(`print(json.dumps(arr.parse_arr_cycles(${JSON.stringify(page)})))`);
    expect(cycle.milestones.reviews_due).toBe("2027-01-20");
    expect(cycle.milestones.author_response).toEqual({ starts: "2027-01-28", ends: "2027-02-03" });
    expect(cycle.milestones.cycle_end).toBe("2027-02-23");
  });

  it("leaves a month-only venue date empty instead of inventing a day", () => {
    const venues = run(`print(json.dumps(arr.parse_participating_venues(html)))`) as Array<any>;
    expect(venues.find((v) => v.venue === "ACL 2027")).toMatchObject({ commitment: "" });
    expect(venues.find((v) => v.venue === "NAACL 2027")).toMatchObject({
      commitment: "2026-12-23",
    });
  });

  it("discovers a newly listed cycle and records source, evidence and check time", () => {
    const rows = run(`
page = html.replace('</tbody>', '<tr><td>January 2027</td><td>January 15</td><td>January 17</td><td>February 20</td><td>March 1-March 8</td><td>March 25</td><td>March 28</td></tr></tbody>', 1)
print(json.dumps(go(page, [])))`);
    expect(rows.arr_2027_january).toMatchObject({
      deadline_date: "2027-01-15",
      deadline_time_precision: "date_only",
      source_url: "https://aclrollingreview.org/dates",
      source_checked_at: "2026-11-23T00:00:00Z",
      deadline_source_status: "portal_unverified",
    });
    expect(rows.arr_2027_january.deadline_source_evidence).toContain("January 2027 | January 15");
    expect(rows.arr_2027_january_rebuttal.deadline_date).toBe("2027-03-08");
    expect(rows.arr_2027_january.schedule.map((s: any) => s.milestone)).toContain("cycle_end");
    expect(rows.arr_2026_march).toBeUndefined();
  });

  it("replaces a stale author-response date with the window the page publishes", () => {
    const rows = run(`
previous = {'arr_2026_august_rebuttal': dict(id='arr_2026_august_rebuttal', deadline_aoe='2026-09-19 23:59:59',
    venue_type='rebuttal', deadline_label='initial author response')}
print(json.dumps(go(html, [dict(previous['arr_2026_august_rebuttal'])], previous)))`);
    expect(rows.arr_2026_august_rebuttal.deadline_date).toBe("2026-09-24");
    expect(rows.arr_2026_october_rebuttal.deadline_date).toBe("2026-11-30");
  });

  it("keeps earlier cycles and marks them unobserved when the page is unreachable", () => {
    const rows = run(`
previous = {'arr_2026_october': dict(id='arr_2026_october', deadline_aoe='2026-10-12 23:59:00',
    deadline_label='ARR submission', source_checked_at='2026-09-11T00:00:00Z')}
print(json.dumps(go(None, [], previous)))`);
    expect(rows.arr_2026_october).toMatchObject({
      _source_observed: false,
      deadline_aoe: "2026-10-12 23:59:00",
      deadline_source_status: "source_unavailable",
    });
    expect(rows.arr_2026_october.source_checked_at).toBe("2026-09-11T00:00:00Z");
  });

  it("flags a venue whose own call disagrees with ARR's commitment date", () => {
    const rows = run(`
items = [dict(id='naacl2027_commitment', deadline_aoe='2026-12-21 23:59:00', deadline_source_kind='official_cfp',
    deadline_time_precision='exact', deadline_label='commitment'),
  dict(id='emnlp2026_commitment', deadline_aoe='2026-08-02 23:59:00', deadline_source_kind='official_cfp',
    deadline_time_precision='exact', deadline_label='commitment', deadline_source_status='portal_unverified')]
print(json.dumps(go(html, items)))`);
    expect(rows.naacl2027_commitment.deadline_source_status).toBe("official_sources_disagree");
    expect(rows.naacl2027_commitment.deadline_conflict_evidence).toContain("2026-12-23");
    expect(rows.naacl2027_commitment.deadline_aoe).toBe("2026-12-21 23:59:00");
    expect(rows.emnlp2026_commitment.deadline_source_status).toBe("portal_unverified");
  });
});
