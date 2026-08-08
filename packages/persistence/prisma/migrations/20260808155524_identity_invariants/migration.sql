/*
  Warnings:

  - A unique constraint covering the columns `[open_request_key]` on the table `registrations` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "registrations_organization_id_requested_login_handle_status_key";

-- AlterTable
ALTER TABLE "registrations" ADD COLUMN "open_request_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "registrations_open_request_key_key" ON "registrations"("open_request_key");
