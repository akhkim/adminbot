// Backfill artifact links (arXiv, Overleaf, code, slides, ...) onto papers that already exist.
//
// Sibling of import-adminbot-data.ts, and deliberately not part of it: that script *inserts* paper
// rows from a sheet export, which is the wrong tool for a database that already holds the papers
// and is only missing their links. This one never inserts, never deletes, and never overwrites a
// link that is already set -- the database is the record of what the lab decided, and a spreadsheet
// export is one person's snapshot of it. It can only fill blanks.
//
// Source is a CSV export of the "Formatted Papers" tab of the Quick-Start Survey workbook, which is
// where the lab actually keeps arXiv and Overleaf URLs. Export it as CSV rather than teaching this
// script to read xlsx: the repo has no spreadsheet dependency and this does not justify adding one.
//
// Dry run by default. Nothing is written until --write is passed, and --write backs the database up
// before the first UPDATE.
//
//   pnpm tsx scripts/adminbot-backfill-paper-links.ts --csv papers.csv --database state/adminbot.sqlite
//   pnpm tsx scripts/adminbot-backfill-paper-links.ts --csv papers.csv --database ... --write

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

type Options = {
  csv: string;
  database: string;
  write: boolean;
  /** Report every unmatched sheet row, not just the count. */
  verbose: boolean;
  /**
   * Ignore sheet rows published before this year.
   *
   * The workbook goes back to 2018, and the old rows are settled history -- their links have been
   * right for years, and touching them is all risk and no gain. 2025 is where the live pipeline
   * starts. Rows with no year at all are idea stubs ("causal ablation study") and never sync.
   */
  sinceYear: number;
  /** Approve every placeholder merge without asking. For unattended runs. */
  yes: boolean;
  /** Do not merge placeholder titles at all; only exact title matches count. */
  noMerge: boolean;
};

/**
 * Sheet column -> artifact field on the paper record.
 *
 * Order matters within a target: the first column that holds a usable URL wins, so a real arXiv
 * link beats a Drive PDF of the same paper. `Paper` is last for `google_drive_pdf_url` because it
 * is a catch-all column -- it holds arXiv links, Drive PDFs and personal-site PDFs alike.
 */
const LINK_COLUMNS: readonly (readonly [column: string, field: string])[] = [
  ["arXiv password", "arxiv_url"],
  ["Paper", "arxiv_url"],
  ["overleaf", "overleaf_edit_url"],
  ["Code", "github_url"],
  ["project_website", "submission_url"],
  ["Slides", "google_slides_url"],
  ["Poster", "poster_url"],
  ["Twitter Thread", "twitter_draft_url"],
  ["twitter_draft", "twitter_draft_url"],
  ["linkedin_url", "linkedin_draft_url"],
  ["Paper", "google_drive_pdf_url"],
];

/** Fields that only ever accept a URL matching this shape, so a wrong column cannot land in them. */
const FIELD_GUARDS: Readonly<Record<string, RegExp>> = {
  arxiv_url: /^https?:\/\/(www\.)?arxiv\.org\//iu,
  overleaf_edit_url: /^https?:\/\/(www\.)?overleaf\.com\//iu,
  github_url: /^https?:\/\/(www\.)?github\.com\//iu,
  google_drive_pdf_url: /^https?:\/\/(drive|docs)\.google\.com\//iu,
  google_slides_url: /^https?:\/\/docs\.google\.com\/presentation\//iu,
};

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    csv: "",
    database: "state/adminbot.sqlite",
    write: false,
    verbose: false,
    sinceYear: 2025,
    yes: false,
    noMerge: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--csv") {
      options.csv = argv[++i] ?? "";
    } else if (arg === "--database") {
      options.database = argv[++i] ?? options.database;
    } else if (arg === "--since-year") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(value)) {
        throw new Error("--since-year needs a year, e.g. --since-year 2025");
      }
      options.sinceYear = value;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--no-merge") {
      options.noMerge = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Backfill arXiv/Overleaf/code links onto existing AdminBot papers.",
          "",
          "  --csv <file>       CSV export of the survey's 'Formatted Papers' tab (required)",
          "  --database <file>  SQLite path (default: state/adminbot.sqlite)",
          "  --since-year <y>   Ignore sheet rows older than this (default: 2025)",
          "  --write            Apply the changes. Without it, nothing is written.",
          "  --yes, -y          Approve every placeholder merge without asking",
          "  --no-merge         Only match on exact titles; never merge placeholders",
          "  --verbose          List every unmatched sheet row.",
          "",
          "Placeholder merges are proposed one at a time and each needs a y/n during --write.",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  if (!options.csv) {
    throw new Error("--csv is required (export the 'Formatted Papers' tab as CSV)");
  }
  return options;
}

/** RFC 4180 enough for a Sheets export: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Title reduced to something two spellings of the same paper agree on.
 *
 * The sheet and the paper record are typed by different people at different times, so they differ
 * in case, punctuation, and smart quotes. Everything that is not a letter or a digit goes.
 */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * The part of a title before its first colon, normalized.
 *
 * This is what lets a placeholder row be recognised as its finished one: the board gets a paper
 * called "WordPlay" long before anyone writes "WordPlay: Text-Based Multi-Agent Environments for RL
 * and LLM Agents". Matching on the colon boundary specifically -- rather than on any word prefix --
 * is what keeps a stub called "Test" away from "Test of Time: ...", whose pre-colon part is
 * "test of time" and so does not match. Even so, every merge is proposed to a person, never taken.
 */
function titleHead(title: string): string {
  return titleKey(title.split(":")[0] ?? "");
}

/** The sheet's Year column holds values like "2026.0" and "". NaN means "no year recorded". */
function parseYear(cell: string): number {
  const value = Number.parseFloat(cell.trim());
  return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/** A cell is a usable link only if it is an http(s) URL -- the sheet also holds notes and "n/a". */
function usableUrl(cell: string): string {
  const value = cell.trim();
  if (!/^https?:\/\//iu.test(value)) {
    return "";
  }
  // Sheets wraps some pasted links in a redirect; the target is the only durable part.
  const redirect = /^https?:\/\/(www\.)?google\.com\/url\?q=([^&]+)/iu.exec(value);
  return redirect ? decodeURIComponent(redirect[2]) : value;
}

function backupPath(database: string): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return `${database}.backup-${stamp}`;
}

type SheetRow = { cells: string[]; title: string; year: number };
type Candidate = { id: string; payload: PaperPayload; title: string; row: SheetRow };
type PaperPayload = { title?: string; artifacts?: Record<string, string | undefined> };

/** Links the sheet row can add to this paper, in field order, skipping anything already set. */
function pendingLinks(
  payload: PaperPayload,
  row: SheetRow,
  columnIndex: ReadonlyMap<string, number>,
): { field: string; value: string }[] {
  const artifacts = { ...payload.artifacts };
  const found: { field: string; value: string }[] = [];
  for (const [column, field] of LINK_COLUMNS) {
    // Never overwrite. A link already on the record was put there by someone who meant it.
    if (artifacts[field]) {
      continue;
    }
    const index = columnIndex.get(column);
    if (index === undefined) {
      continue;
    }
    const url = usableUrl(row.cells[index] ?? "");
    if (!url) {
      continue;
    }
    const guard = FIELD_GUARDS[field];
    if (guard && !guard.test(url)) {
      continue;
    }
    artifacts[field] = url;
    found.push({ field, value: url });
  }
  return found;
}

/**
 * Ask about one merge. Anything but y/yes is a no, and a closed stdin is a no.
 *
 * Defaulting to "no" matters: this runs against the lab's live database, and the failure mode of a
 * wrong yes (two papers collapsed into one) is much worse than a wrong no (a placeholder keeps its
 * short title for another week).
 */
async function confirmMerge(rl: readline.Interface, candidate: Candidate): Promise<boolean> {
  console.log(`\n  placeholder: "${candidate.title}"`);
  console.log(`  sheet row:   "${candidate.row.title}" (${candidate.row.year})`);
  const answer = await rl.question("  Same paper? Adopt the fuller title and its links [y/N] ");
  return /^y(es)?$/iu.test(answer.trim());
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.database)) {
    throw new Error(`Database not found: ${options.database}`);
  }

  const rows = parseCsv(fs.readFileSync(options.csv, "utf8"));
  if (rows.length < 2) {
    throw new Error(`No rows in ${options.csv}`);
  }
  const header = rows[0].map((cell) => cell.trim());
  const columnIndex = new Map(header.map((name, index) => [name, index]));
  const titleColumn = columnIndex.get("Title");
  if (titleColumn === undefined) {
    throw new Error(`No "Title" column in ${options.csv}; is this the Formatted Papers tab?`);
  }
  const yearColumn = columnIndex.get("Year");

  let skippedOld = 0;
  let skippedUndated = 0;
  const kept: SheetRow[] = [];
  for (const cells of rows.slice(1)) {
    const title = (cells[titleColumn] ?? "").trim();
    if (!title) {
      continue;
    }
    const year = yearColumn === undefined ? Number.NaN : parseYear(cells[yearColumn] ?? "");
    if (Number.isNaN(year)) {
      skippedUndated++;
      continue;
    }
    if (year < options.sinceYear) {
      skippedOld++;
      continue;
    }
    kept.push({ cells, title, year });
  }

  // Sheet rows keyed by exact title, and separately by pre-colon head for the placeholder merge.
  // A head shared by two rows is not usable -- a guess between two papers is worse than leaving the
  // placeholder alone -- so those heads are dropped rather than resolved.
  const byTitle = new Map<string, SheetRow>();
  const byHead = new Map<string, SheetRow | null>();
  for (const row of kept) {
    const key = titleKey(row.title);
    if (!byTitle.has(key)) {
      byTitle.set(key, row);
    }
    const head = titleHead(row.title);
    if (head && head !== key) {
      byHead.set(head, byHead.has(head) ? null : row);
    }
  }

  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(options.database);
  const papers = db.prepare("SELECT id, payload_json FROM adminbot_papers").all() as {
    id: string;
    payload_json: string;
  }[];

  type Change = { title: string; field: string; value: string };
  const changes: Change[] = [];
  const updates = new Map<string, string>();
  const usedKeys = new Set<string>();
  const mergeCandidates: Candidate[] = [];
  let matchedExact = 0;

  for (const paper of papers) {
    const payload = JSON.parse(paper.payload_json) as PaperPayload;
    const title = (payload.title ?? "").trim();
    if (!title) {
      continue;
    }
    const key = titleKey(title);
    const row = byTitle.get(key);
    if (!row) {
      // The paper's whole title is a sheet title's pre-colon half: a placeholder and its finished
      // version. `null` means the head was ambiguous and was deliberately dropped above. These are
      // collected rather than applied -- a person decides each one below.
      const candidate = options.noMerge ? undefined : byHead.get(key);
      if (candidate) {
        mergeCandidates.push({ id: paper.id, payload, title, row: candidate });
      }
      continue;
    }
    matchedExact++;
    usedKeys.add(titleKey(row.title));

    const links = pendingLinks(payload, row, columnIndex);
    if (links.length === 0) {
      continue;
    }
    const artifacts = { ...payload.artifacts };
    for (const link of links) {
      artifacts[link.field] = link.value;
      changes.push({ title, field: link.field, value: link.value });
    }
    updates.set(paper.id, JSON.stringify({ ...payload, artifacts }));
  }

  console.log(`papers in database:        ${papers.length}`);
  console.log(`sheet rows from ${options.sinceYear} on:   ${kept.length}`);
  console.log(`  skipped, older:          ${skippedOld}`);
  console.log(`  skipped, no year:        ${skippedUndated}`);
  console.log(`matched by exact title:    ${matchedExact}`);
  console.log(`placeholder merges to ask: ${mergeCandidates.length}`);
  console.log(`links from exact matches:  ${changes.length}`);

  if (mergeCandidates.length > 0) {
    console.log("\nproposed placeholder merges:");
    for (const candidate of mergeCandidates) {
      const links = pendingLinks(candidate.payload, candidate.row, columnIndex);
      console.log(`  "${candidate.title}"  ->  "${candidate.row.title}" (${candidate.row.year})`);
      console.log(
        `    ${links.length} link${links.length === 1 ? "" : "s"} would follow${
          links.length > 0 ? `: ${links.map((l) => l.field).join(", ")}` : ""
        }`,
      );
    }
  }

  if (!options.write) {
    console.log("\nDry run. Nothing written.");
    if (mergeCandidates.length > 0) {
      console.log("Re-run with --write to apply links and be asked about each merge.");
    } else {
      console.log("Re-run with --write to apply.");
    }
    db.close();
    return;
  }

  // Approvals happen before any write, so an interrupted prompt leaves the database untouched.
  let approved = 0;
  if (mergeCandidates.length > 0) {
    const interactive = process.stdin.isTTY === true;
    if (!options.yes && !interactive) {
      console.log("\nstdin is not a terminal; skipping every merge. Pass --yes to approve them.");
    } else {
      console.log("\nplaceholder merges:");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const candidate of mergeCandidates) {
          const ok = options.yes || (await confirmMerge(rl, candidate));
          if (!ok) {
            continue;
          }
          approved++;
          usedKeys.add(titleKey(candidate.row.title));
          const links = pendingLinks(candidate.payload, candidate.row, columnIndex);
          const artifacts = { ...candidate.payload.artifacts };
          for (const link of links) {
            artifacts[link.field] = link.value;
            changes.push({ title: candidate.title, field: link.field, value: link.value });
          }
          updates.set(
            candidate.id,
            JSON.stringify({ ...candidate.payload, artifacts, title: candidate.row.title }),
          );
        }
      } finally {
        rl.close();
      }
      console.log(`\napproved ${approved} of ${mergeCandidates.length} merges.`);
    }
  }

  const unmatched = kept.filter((row) => !usedKeys.has(titleKey(row.title)));
  if (options.verbose && unmatched.length > 0) {
    console.log("\nsheet rows with no matching paper:");
    for (const row of unmatched) {
      console.log(`  ${row.year}  ${row.title.slice(0, 90)}`);
    }
  }

  if (updates.size === 0) {
    console.log("\nNothing to write.");
    db.close();
    return;
  }

  // Back up before the first write, not after: a backup taken later is a backup of the damage.
  const backup = backupPath(options.database);
  fs.copyFileSync(options.database, backup);
  console.log(`\nBacked up to ${path.resolve(backup)}`);

  const update = db.prepare("UPDATE adminbot_papers SET payload_json = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const [id, payload] of updates) {
      update.run(payload, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(
    `Wrote ${changes.length} links across ${updates.size} papers` +
      (approved > 0 ? `, and renamed ${approved}.` : "."),
  );
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
