import { createHash, createHmac } from "node:crypto";

export function openRegistrationEmailKey(organizationId: string, email: string): string {
  return publicIdentityKey("open-email", `${organizationId}\0${email}`);
}

export function openClaimPersonKey(organizationId: string, personId: string): string {
  return publicIdentityKey("open-claim-person", `${organizationId}\0${personId}`);
}

/** Produces non-reversible durable keys without placing raw login handles or addresses in indexes. */
export class IdentityKeyDeriver {
  private readonly secret: Buffer;

  constructor(secret: string | Buffer) {
    const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, "utf8");
    if (bytes.length < 32) throw new Error("identity key secret must contain at least 32 bytes");
    this.secret = bytes;
  }

  openRegistrationEmail(organizationId: string, email: string): string {
    return openRegistrationEmailKey(organizationId, email);
  }

  openClaimPerson(organizationId: string, personId: string): string {
    return openClaimPersonKey(organizationId, personId);
  }

  registrationEmailAttempt(organizationId: string, email: string): string {
    return this.derive("registration-email", `${organizationId}\0${email}`);
  }

  registrationAddressAttempt(organizationId: string, remoteAddress: string): string {
    return this.derive("registration-address", `${organizationId}\0${remoteAddress}`);
  }

  loginEmailAttempt(organizationId: string, email: string): string {
    return this.derive("login-email", `${organizationId}\0${email}`);
  }

  loginAddressAttempt(organizationId: string, remoteAddress: string): string {
    return this.derive("login-address", `${organizationId}\0${remoteAddress}`);
  }

  sessionToken(rawToken: string): string {
    return this.derive("session-token", rawToken);
  }

  private derive(scope: string, value: string): string {
    const digest = createHmac("sha256", this.secret)
      .update(scope)
      .update("\0")
      .update(value)
      .digest("hex");
    return `v1:${scope}:${digest}`;
  }
}

function publicIdentityKey(scope: string, value: string): string {
  const digest = createHash("sha256").update(scope).update("\0").update(value).digest("hex");
  return `v1:${scope}:${digest}`;
}
