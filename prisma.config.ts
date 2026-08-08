import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env.ADMINBOT_DATABASE_URL ?? "file:./state/adminbot-v2.sqlite";

export default defineConfig({
  schema: "packages/persistence/prisma/schema.prisma",
  migrations: {
    path: "packages/persistence/prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
