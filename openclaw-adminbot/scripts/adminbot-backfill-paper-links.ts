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
// Dry run by default. Nothing is written until --write is passed, and --write refuses to run
// against a database it cannot back up first.
//
//   pnpm tsx scripts/adminbot-backfill-paper-links.ts --csv papers.csv --database state/adminbot.sqlite
//   pnpm tsx scripts/adminbot-backfill-paper-links.ts --csv papers.csv --database ... --write

import fs from "node:fs";
import path from "node:path";

type Options = {
  csv: string;
  database: string;
  write: boolean;
  /** Report every unmatched sheet row, not just the count. */
  verbose: boolean;
};

/**
 * Sheet column -> artifact field on the paper record.
 *
 * Order matters within a target: the first column that holds a usable URL wins, so a real arXiv
 * link beats a Drive PDF of the same paper. `Paper` is last for `submission_url` because it is a
 * catch-all column in the sheet -- it holds arXiv links, Drive PDFs and personal-site PDFs alike.
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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--csv") {
      options.csv = argv[++i] ?? "";
    } else if (arg === "--database") {
      options.database = argv[++i] ?? options.database;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Backfill arXiv/Overleaf/code links onto existing AdminBot papers.",
          "",
          "  --csv <file>       CSV export of the survey's 'Formatted Papers' tab (required)",
          "  --database <file>  SQLite path (default: state/adminbot.sqlite)",
          "  --write            Apply the changes. Without it, nothing is written.",
          "  --verbose          List every unmatched sheet row.",
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

  // Sheet rows keyed by title. A duplicate title keeps the first row: the sheet lists a paper once
  // per cycle, and the earlier row is the one that carries the published link.
  const sheet = new Map<string, string[]>();
  for (const row of rows.slice(1)) {
    const title = (row[titleColumn] ?? "").trim();
    if (!title) {
      continue;
    }
    const key = titleKey(title);
    if (!sheet.has(key)) {
      sheet.set(key, row);
    }
  }

  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(options.database);
  const papers = db.prepare("SELECT id, payload_json FROM adminbot_papers").all() as {
    id: string;
    payload_json: string;
  }[];

  type Change = { id: string; title: string; field: string; value: string };
  const changes: Change[] = [];
  const updates = new Map<string, string>();
  const matchedKeys = new Set<string>();
  let matched = 0;

  for (const paper of papers) {
    const payload = JSON.parse(paper.payload_json) as {
      title?: string;
      artifacts?: Record<string, string | undefined>;
    };
    const title = (payload.title ?? "").trim();
    if (!title) {
      continue;
    }
    const key = titleKey(title);
    const row = sheet.get(key);
    if (!row) {
      continue;
    }
    matched++;
    matchedKeys.add(key);

    const artifacts = { ...payload.artifacts };
    let touched = false;
    for (const [column, field] of LINK_COLUMNS) {
      // Never overwrite. A link already on the record was put there by someone who meant it.
      if (artifacts[field]) {
        continue;
      }
      const index = columnIndex.get(column);
      if (index === undefined) {
        continue;
      }
      const url = usableUrl(row[index] ?? "");
      if (!url) {
        continue;
      }
      const guard = FIELD_GUARDS[field];
      if (guard && !guard.test(url)) {
        continue;
      }
      artifacts[field] = url;
      changes.push({ id: paper.id, title, field, value: url });
      touched = true;
    }
    if (touched) {
      updates.set(paper.id, JSON.stringify({ ...payload, artifacts }));
    }
  }

  const unmatchedSheet = [...sheet.entries()].filter(([key]) => !matchedKeys.has(key));

  console.log(`papers in database:      ${papers.length}`);
  console.log(`rows in sheet:           ${sheet.size}`);
  console.log(`matched by title:        ${matched}`);
  console.log(`papers gaining a link:   ${updates.size}`);
  console.log(`links to fill:           ${changes.length}`);
  console.log(`sheet rows with no paper: ${unmatchedSheet.length}`);

  const byField = new Map<string, number>();
  for (const change of changes) {
    byField.set(change.field, (byField.get(change.field) ?? 0) + 1);
  }
  if (byField.size > 0) {
    console.log("\nby field:");
    for (const [field, count] of [...byField].toSorted((a, b) => b[1] - a[1])) {
      console.log(`  ${field.padEnd(22)} ${count}`);
    }
  }

  console.log("\nchanges:");
  for (const change of changes) {
    console.log(`  ${change.title.slice(0, 64).padEnd(64)} ${change.field} = ${change.value}`);
  }

  if (options.verbose && unmatchedSheet.length > 0) {
    console.log("\nsheet rows with no matching paper:");
    for (const [, row] of unmatchedSheet) {
      console.log(`  ${(row[titleColumn] ?? "").slice(0, 96)}`);
    }
  }

  if (!options.write) {
    console.log("\nDry run. Nothing written. Re-run with --write to apply.");
    db.close();
    return;
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
  console.log(`Wrote ${changes.length} links across ${updates.size} papers.`);
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
