import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));

function refresh(
  options: {
    split?: boolean;
    observed?: boolean;
    cached?: boolean;
    force?: boolean;
    failed?: boolean;
  } = {},
) {
  const result = execFileSync(
    "python3",
    [
      "-c",
      `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(scripts)})
spec = importlib.util.spec_from_file_location('collector', ${JSON.stringify(scripts)} + 'adminbot-deadline-collect.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
options = json.loads(${JSON.stringify(JSON.stringify(options))})
old_check = '2035-01-01T12:00:00Z'
new_check = '2035-01-02T12:00:00Z'
m.checked_at = lambda: new_check
html = '<p>Paper submission deadline: February 10, 2035, 23:59 AoE</p>'
if options.get('split'):
    html += '<p>Abstract registration deadline: February 1, 2035, 23:59 AoE</p>'
profile = m.workshop_profile_from_html(html, 'https://workshop.example/cfp', 2035)
profile['profile_extracted_at'] = old_check
previous = dict(id='test2035_ws', name='Example', venue_type='workshop', venue_group='TEST 2035',
    homepage_url='https://workshop.example', cfp_url='https://workshop.example/cfp',
    deadline_aoe='2035-02-10 23:59:00', deadline_label='full paper' if options.get('split') else 'submission',
    source_checked_at=old_check, profile_extracted_at=old_check, topic_profile=['Testing'],
    source_url='https://openreview.net/group?id=TEST', archival_status='non_archival',
    cross_submission_status='allowed')
if options.get('cached', True):
    previous['website_deadline_candidates'] = profile['_deadline_candidates']
previous_by_id = {previous['id']: previous}
if options.get('split'):
    previous_by_id[previous['id'] + '_abstract'] = dict(previous,
        id=previous['id'] + '_abstract', deadline_label='abstract registration', deadline_aoe='2035-02-01 23:59:00')
portal = '2035-02-02 23:59:00' if options.get('split') else '2035-02-12 23:59:00'
observed = options.get('observed', True)
item = dict(id=previous['id'], name='Example', venue_type='workshop', venue_group='TEST 2035',
    homepage_url=previous['homepage_url'], openreview_url=previous['source_url'],
    deadline_aoe=portal if observed else previous['deadline_aoe'],
    _openreview_deadline=portal if observed else '', _source_observed=observed,
    source_checked_at=new_check if observed else old_check)
if options.get('split'):
    item['_full_submission_deadline'] = '2035-02-12 23:59:00'
calls = []
def discover(*args):
    calls.append(args[0])
    if options.get('failed'):
        raise RuntimeError('synthetic website failure')
    return previous['cfp_url'], previous['archival_status'], dict(profile, profile_extracted_at=new_check)
m.discover_workshop_profile = discover
items = [item]
m.enrich_workshop_sources(items, previous_by_id, m.AoEClock.resolve('2035-01-02'), options.get('force', False))
items = [m.merge_history(m.classify(row), previous_by_id.get(row['id'])) for row in items]
print(json.dumps(dict(items=items, calls=calls)))
`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(result.trim().split("\n").at(-1)!) as {
    items: Array<Record<string, any>>;
    calls: string[];
  };
}

describe("workshop refresh between website checks", () => {
  it("keeps a fresh portal cutoff and the older website extraction time", () => {
    const {
      items: [item],
      calls,
    } = refresh();
    expect(calls).toEqual([]);
    expect(item.deadline_aoe).toBe("2035-02-12 23:59:00");
    expect(item.source_checked_at).toBe("2035-01-02T12:00:00Z");
    expect(item.profile_extracted_at).toBe("2035-01-01T12:00:00Z");
    expect(item.deadline_source_status).toBe("cfp_disagrees_with_openreview");
    expect(item.deadline_official_evidence).toContain("February 10");
    expect(item.topic_profile).toEqual(["Testing"]);
    expect(item.cross_submission_status).toBe("allowed");
    expect(item.revisions.map((r: Record<string, unknown>) => r.deadline_aoe)).toEqual([
      "2035-02-10 23:59:00",
      "2035-02-12 23:59:00",
    ]);
  });

  it("reconciles abstract and full-paper invitations separately against cached evidence", () => {
    const { items, calls } = refresh({ split: true });
    expect(calls).toEqual([]);
    expect(items.map((item) => [item.id, item.deadline_aoe])).toEqual([
      ["test2035_ws", "2035-02-12 23:59:00"],
      ["test2035_ws_abstract", "2035-02-02 23:59:00"],
    ]);
  });

  it("retains both prior milestones and clocks when no fresh observation is available", () => {
    const { items, calls } = refresh({ split: true, observed: false });
    expect(calls).toEqual([]);
    expect(items.map((item) => item.deadline_aoe)).toEqual([
      "2035-02-10 23:59:00",
      "2035-02-01 23:59:00",
    ]);
    expect(items.every((item) => item.source_checked_at === "2035-01-01T12:00:00Z")).toBe(true);
  });

  it("populates missing candidate evidence on the first refresh of a legacy record", () => {
    const {
      items: [item],
      calls,
    } = refresh({ cached: false });
    expect(calls).toEqual(["https://workshop.example"]);
    expect(item.website_deadline_candidates.length).toBeGreaterThan(0);
    expect(item.deadline_aoe).toBe("2035-02-12 23:59:00");
  });

  it("keeps cached stage evidence when a forced website request fails", () => {
    const { items, calls } = refresh({ force: true, failed: true, split: true });
    expect(calls).toHaveLength(1);
    expect(items.map((item) => item.deadline_aoe)).toEqual([
      "2035-02-12 23:59:00",
      "2035-02-02 23:59:00",
    ]);
    expect(items.every((item) => item.profile_extracted_at === "2035-01-01T12:00:00Z")).toBe(true);
    expect(items.every((item) => item.cfp_url === "https://workshop.example/cfp")).toBe(true);
  });

  it("does not manufacture an empty cache when an older record has no new observation", () => {
    const {
      items: [item],
      calls,
    } = refresh({ observed: false, cached: false });
    expect(calls).toEqual([]);
    expect(item).not.toHaveProperty("website_deadline_candidates");
  });

  it("force-refreshes the website even when candidate evidence is cached", () => {
    const {
      items: [item],
      calls,
    } = refresh({ force: true });
    expect(calls).toHaveLength(1);
    expect(item.profile_extracted_at).toBe("2035-01-02T12:00:00Z");
  });
});
