// The account-registration row shape and its SELECT, moved out of sqlite.ts to keep that file
// under its size cap. The store is still the only reader.
import type {
  AdminBotAccountRegistration,
  AdminBotRegistrationKind,
  AdminBotRegistrationStatus,
} from "../contracts/actions.js";

export const REGISTRATION_COLUMNS = `SELECT id, kind, member_id, email, password_scrypt, profile_json, status, created_at, decided_at, decided_by
  FROM adminbot_account_registrations`;

export type AccountRegistrationRow = {
  id: string;
  kind: AdminBotRegistrationKind;
  member_id: string | null;
  email: string;
  password_scrypt: string;
  profile_json: string | null;
  status: AdminBotRegistrationStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export function rowToRegistration(row: AccountRegistrationRow): AdminBotAccountRegistration {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email,
    password_scrypt: row.password_scrypt,
    status: row.status,
    created_at: row.created_at,
    ...(row.member_id ? { member_id: row.member_id } : {}),
    ...(row.profile_json ? { profile_json: row.profile_json } : {}),
    ...(row.decided_at ? { decided_at: row.decided_at } : {}),
    ...(row.decided_by ? { decided_by: row.decided_by } : {}),
  };
}
