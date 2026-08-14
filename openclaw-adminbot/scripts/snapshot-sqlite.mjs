#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [sourceArgument, destinationArgument] = process.argv.slice(2);

if (!sourceArgument || !destinationArgument) {
  console.error("usage: snapshot-sqlite.mjs <source.sqlite> <destination.sqlite>");
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

try {
  const escapedDestination = destination.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escapedDestination}'`);
} finally {
  database.close();
}

fs.chmodSync(destination, 0o600);
