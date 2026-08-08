import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

export interface PersistenceOptions {
  /** Prisma SQLite URL, for example `file:./state/adminbot-v2.sqlite`. */
  readonly databaseUrl: string;
}

export function createPrismaClient(options: PersistenceOptions): PrismaClient {
  if (!options.databaseUrl.startsWith("file:")) {
    throw new Error("v0alpha persistence requires a file: SQLite URL");
  }
  const adapter = new PrismaBetterSqlite3({ url: options.databaseUrl, timeout: 5_000 });
  return new PrismaClient({ adapter });
}
