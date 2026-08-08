CREATE TABLE "administrator_policies" (
  "organization_id" TEXT NOT NULL PRIMARY KEY,
  "policy_version" TEXT NOT NULL,
  "reimbursement_submission_enabled" BOOLEAN NOT NULL,
  "reimbursement_approval_roles" JSONB NOT NULL,
  "reimbursement_approval_quorum" INTEGER NOT NULL,
  "reimbursement_requester_may_approve" BOOLEAN NOT NULL,
  "reimbursement_distinct_approvers" BOOLEAN NOT NULL,
  "reimbursement_recent_reauthentication_required" BOOLEAN NOT NULL,
  "reimbursement_approval_expiry_hours" INTEGER NOT NULL,
  "reimbursement_destinations" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "governed_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "client_request_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "action_type" TEXT NOT NULL,
  "action_version" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "canonical_payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "requested_by_account_id" TEXT NOT NULL,
  "requested_by_person_id" TEXT NOT NULL,
  "requested_at" DATETIME NOT NULL,
  "policy_decision_id" TEXT NOT NULL,
  "policy_version" TEXT NOT NULL,
  "risk" TEXT NOT NULL,
  "eligible_roles" JSONB NOT NULL,
  "approval_quorum" INTEGER NOT NULL,
  "requester_may_approve" BOOLEAN NOT NULL,
  "distinct_people" BOOLEAN NOT NULL,
  "recent_reauthentication_required" BOOLEAN NOT NULL,
  "expires_at" DATETIME NOT NULL,
  "safe_failure_code" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "governed_approvals" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "action_id" TEXT NOT NULL,
  "action_revision" INTEGER NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "policy_decision_id" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "decided_by_person_id" TEXT NOT NULL,
  "role_basis" JSONB NOT NULL,
  "note" TEXT,
  "decided_at" DATETIME NOT NULL,
  CONSTRAINT "governed_approvals_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "governed_actions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "governed_actions_organization_id_client_request_id_key" ON "governed_actions"("organization_id", "client_request_id");
CREATE INDEX "governed_actions_organization_id_state_requested_at_idx" ON "governed_actions"("organization_id", "state", "requested_at");
CREATE UNIQUE INDEX "governed_approvals_action_id_decided_by_person_id_key" ON "governed_approvals"("action_id", "decided_by_person_id");
CREATE INDEX "governed_approvals_action_id_decided_at_idx" ON "governed_approvals"("action_id", "decided_at");
