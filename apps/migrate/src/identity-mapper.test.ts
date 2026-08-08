import { describe, expect, it } from "vitest";
import { mapLegacyIdentity } from "./identity-mapper.js";
import type { LegacyIdentitySnapshot } from "./legacy-source.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const VALID_HASH = [
  "scrypt",
  "16384",
  "8",
  "1",
  Buffer.alloc(32, 1).toString("base64url"),
  Buffer.alloc(64, 2).toString("base64url"),
].join("$");

describe("legacy identity mapper", () => {
  it("maps legacy roles, retains supported hashes, and requires reclaim for invalid handles", () => {
    const snapshot = syntheticSnapshot();
    const options = {
      organizationId: ORGANIZATION_ID,
      sourceFingerprint: "a".repeat(64),
      completedAt: new Date("2026-08-08T12:00:00.000Z"),
    };

    const result = mapLegacyIdentity(snapshot, options);

    expect(result.issues).toEqual([]);
    expect(result.report).toMatchObject({
      people: 2,
      accounts: 1,
      credentialAccountsRequiringReclaim: 1,
      registrations: 1,
      roleAssignments: 6,
      legacySessionsInvalidated: 2,
    });
    expect(result.batch?.accounts[0]).toMatchObject({
      loginHandle: "admin@example.com",
      passwordHash: VALID_HASH,
    });
    expect(result.batch?.roles.map((role) => role.role)).toEqual([
      "member",
      "administrator",
      "approver",
      "security_operator",
      "auditor",
      "external_collaborator",
    ]);
    expect(result.batch?.registrations[0]).toMatchObject({
      kind: "claim",
      status: "submitted",
      passwordHash: VALID_HASH,
    });
    expect(result.batch?.registrations[0]?.openRequestKey).toMatch(/^v1:open-email:/u);
    expect(JSON.stringify(result.report)).not.toContain("admin@example.com");
    expect(JSON.stringify(result.report)).not.toContain(VALID_HASH);
    expect(mapLegacyIdentity(snapshot, options).batch?.people).toEqual(result.batch?.people);
  });

  it("fails closed with row positions and no row values", () => {
    const snapshot = syntheticSnapshot();
    const invalid: LegacyIdentitySnapshot = {
      ...snapshot,
      members: [
        {
          ...snapshot.members[0]!,
          payload_json: JSON.stringify({
            id: "private-member-id",
            name: "Private Person Name",
            privilege_level: "unexpected",
            created_at: "invalid",
          }),
        },
      ],
      credentials: [],
      registrations: [],
    };

    const result = mapLegacyIdentity(invalid, {
      organizationId: ORGANIZATION_ID,
      sourceFingerprint: "b".repeat(64),
      completedAt: new Date("2026-08-08T12:00:00.000Z"),
    });

    expect(result.batch).toBeUndefined();
    expect(result.issues).toMatchObject([
      { code: "member_invalid", table: "adminbot_lab_members", rowNumber: 1 },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain("Private Person Name");
    expect(JSON.stringify(result.issues)).not.toContain("private-member-id");
  });
});

function syntheticSnapshot(): LegacyIdentitySnapshot {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    members: [
      {
        id: "legacy-admin",
        privilege_level: "admin",
        updated_at: timestamp,
        payload_json: JSON.stringify({
          id: "legacy-admin",
          name: "Synthetic Administrator",
          privilege_level: "admin",
          status: "active",
          created_at: timestamp,
        }),
      },
      {
        id: "legacy-collaborator",
        privilege_level: "external_collaborator",
        updated_at: timestamp,
        payload_json: JSON.stringify({
          id: "legacy-collaborator",
          name: "Synthetic Collaborator",
          privilege_level: "external_collaborator",
          status: "active",
          created_at: timestamp,
        }),
      },
    ],
    credentials: [
      {
        member_id: "legacy-admin",
        email: "ADMIN@example.com",
        password_scrypt: VALID_HASH,
        claimed_at: timestamp,
        updated_at: timestamp,
      },
      {
        member_id: "legacy-collaborator",
        email: "invalid-placeholder",
        password_scrypt: VALID_HASH,
        claimed_at: timestamp,
        updated_at: timestamp,
      },
    ],
    registrations: [
      {
        id: "legacy-registration",
        kind: "claim",
        member_id: "legacy-collaborator",
        email: "collaborator@example.com",
        password_scrypt: VALID_HASH,
        profile_json: null,
        status: "pending",
        created_at: timestamp,
        decided_at: null,
        decided_by: null,
      },
    ],
    legacySessionCount: 2,
    sourceTableCount: 14,
  };
}
