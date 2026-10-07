#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [sourceArgument, destinationArgument, verify] = process.argv.slice(2);

if (!sourceArgument || !destinationArgument || (verify && verify !== "--verify")) {
  console.error("usage: snapshot-sqlite.mjs <source.sqlite> <destination.sqlite> [--verify]");
  process.exit(2);
}

const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);

if (!fs.statSync(source).isFile()) {
  throw new Error(`SQLite source is not a file: ${source}`);
}
if (fs.existsSync(destination)) {
  throw new Error(`Snapshot destination already exists: ${destination}`);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
const database = new DatabaseSync(source, { readOnly: true });

function checkedTableCounts(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return [name, db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count];
    });
}

try {
  const escapedDestination = destination.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escapedDestination}'`);
  fs.chmodSync(destination, 0o600);
  if (verify) {
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      if (
        JSON.stringify(checkedTableCounts(database)) !==
        JSON.stringify(checkedTableCounts(snapshot))
      ) {
        throw new Error("SQLite snapshot table counts differ from source");
      }
    } finally {
      snapshot.close();
    }
  }
} finally {
  database.close();
}
