/*
  Warnings:

  - A unique constraint covering the columns `[open_claim_person_key]` on the table `registrations` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "registrations" ADD COLUMN "open_claim_person_key" TEXT;

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "attempt_count" INTEGER NOT NULL,
    "window_started_at" DATETIME NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_updated_at_idx" ON "rate_limit_buckets"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_open_claim_person_key_key" ON "registrations"("open_claim_person_key");
