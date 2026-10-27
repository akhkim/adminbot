# API tokens and CLI sign-in

Status: implemented in `codex/api-tokens`. Owner: AdminBot maintainers.

## Why

Scripts and coding agents need to call AdminBot without a browser. Before this change, the CLI
(`extensions/adminbot/cli`, PR #521) signed in with an email and password. It then kept the
resulting 7-day browser session in a plaintext file. That has four problems:

- The password has to be typed into a terminal, or an agent has to be given it.
- The credential cannot be named, listed or revoked on its own.
- Nothing shows when or where it was last used.
- A copied credentials file, or one pasted into a log or commit, works for anybody.

This design follows what Modal, GitHub and Stripe do for their CLIs: a browser approves the
sign-in, and the server issues a named, expiring, revocable personal access token.

## What a member gets

```
$ adminbot auth login --name claude-laptop
To sign in, open https://adminbot.example/profile?cliLogin=WDJB-MJHT
and check that it shows this code: WDJB-MJHT
Approve it only if you started this login. Waiting…
{"authenticated": true, "member": {...}, "api_token": {"id": "tok_…", "name": "claude-laptop", ...}}

$ adminbot get-papers --limit 5        # every API operation, as before
$ adminbot auth tokens list
$ adminbot auth tokens revoke tok_…    # or: adminbot auth tokens revoke-all
$ adminbot auth logout                 # revokes this token and removes it from the Keychain
```

Options: `--name` (default "adminbot CLI on <host>"), `--days 1..90`, `--no-browser` (print the
link only), `--url`, `--timeout`. `adminbot auth login --email … --password-stdin` still signs in
with a password and a browser session, for older setups.

The **API tokens** section of **My Profile** lists every token with:

- the device it was created on,
- when and where it was last used (time, city and IP),
- when it expires,
- a **Revoke** button, and a **Revoke all** button.

The same section can also create a token directly, for a CI job. The token is shown once.

## Token format

`abt_<43 base64url chars: 32 random bytes>_<8 hex chars: CRC32 of the part before it>`

- The `abt_` prefix makes a leaked token easy to grep for and impossible to mistake for a session.
- The checksum lets the secret scanner tell a real token from a random string without a network
  call. GitHub does the same.
- The server stores only `sha256(token)`, the same as for sessions. The token carries 256 random
  bits, so a peppered or slow hash adds nothing.
- Each token row has a separate public id, `tok_…`, used for listing and revoking. The secret is
  never shown again after it is created. The UI shows its last four characters as a hint.

## Who may have tokens

`apiTokensAllowed(member)` decides who may have a token. It is checked when a token is created
and again on every request, so demoting a member stops their tokens at once.

- The default is `privilege_level === "admin"`.
- `ADMINBOT_API_TOKEN_LEVELS` (comma-separated privilege levels) widens it. For example,
  `admin,member` opens tokens to every member later. No schema or code change is needed.

## Rights

A token acts as its owner, with the owner's full rights. Approve-then-execute governance is
unchanged. A token cannot:

- create or approve another token, or approve a CLI sign-in,
- change the owner's password or email,
- start or stop impersonation.

So a leaked token cannot make itself permanent or lock its owner out. Impersonation sessions
cannot create tokens either.

## Lifetime

| Rule           | Value                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| Default expiry | 30 days                                                                                       |
| Maximum expiry | 90 days                                                                                       |
| Revoked when   | unused for 30 days                                                                            |
| Revoked when   | the password is changed or reset, the member is deleted or merged, or "Revoke all" is pressed |
| Rate limit     | 600 requests a minute per token (429 above it)                                                |

Every place that revokes a member's sessions also revokes their tokens, inside the same store
call. Paths added later cannot forget this.

## Browser sign-in (device flow, after RFC 8628)

1. `POST /auth/device/start {name, expires_in_days}` (anonymous, rate-limited by IP). It returns
   a `device_code` (32 random bytes, kept by the CLI only), a `user_code` such as `WDJB-MJHT`, the
   approval URL and a 10-minute expiry.
2. The CLI opens `/profile?cliLogin=WDJB-MJHT`. The app reads the code out of the URL (and drops
   it from the address bar), and My Profile shows the approval card. The page requires a
   signed-in browser. `POST /auth/device/lookup {user_code}` gives it the token name, expiry and
   the IP of the request, and it asks for the member's password again.
3. `POST /auth/device/approve {user_code, password}` creates the token, which is held for the CLI.
   `POST /auth/device/deny {user_code}` cancels the request.
4. The CLI polls `POST /auth/device/poll {device_code}`. It gets the token exactly once, after
   which the request is deleted.

**Why the password is asked for again.** Somebody who sends a member a link cannot get a token
from a browser that is merely signed in. The `device_code` never leaves the CLI, so only the
process that started the sign-in can collect the token. User codes avoid ambiguous letters, and
a guessed code still needs the victim's password.

Pending sign-ins are kept in memory. The service runs as one process, and a restart just asks
the CLI user to try again. `DeviceLoginStore` is an interface, so a shared table can replace it if
the service is ever scaled out.

## Seeing use

- **Last use.** `last_used_at`, IP and city are written at most once every 5 minutes per token,
  and immediately on a new IP.
- **New IP.** The first use from an IP not seen before writes an `auth.api_token.new_ip` audit
  line, and the token list marks it. An injectable `onApiTokenNewIp` hook can send an email
  alert. It is not wired by default, because a new outbound email needs the owner's sign-off.
- **Attribution.** Every audit event written during a token request gets
  `details.via_api_token = {id, name}` through an `AsyncLocalStorage` request context. So the
  trail reads "member-a via claude-laptop". `actor` stays the member id, so "my edits" views
  are unaffected.
- **Lifecycle audits.** Creation and revocation are audited as `auth.api_token.created`,
  `auth.api_token.revoked` and `auth.api_token.revoked_all`.

## Keeping tokens from leaking

**CLI**

- On macOS the token is stored in the login Keychain:
  - service `adminbot`, account = server origin;
  - it is written through `security -i` on stdin, so it never appears in `ps`;
  - the credentials file then holds only metadata (id, name, expiry), no secret.
- Elsewhere, or with `ADMINBOT_KEYCHAIN=0`, the token goes in the existing 0600 file.
- The token is never printed.
- The CLI refuses plain `http://` except for localhost, and only opens an `https:` (or loopback)
  approval link in the browser.
- Error output has any `abt_…` string replaced with `abt_[REDACTED]`.
- `ADMINBOT_TOKEN` still overrides, for CI.

**Agents.** An agent runs `adminbot …` and never has to read or handle the token.

This keeps the token out of prompts, transcripts, files and commits. It does not stop a hostile
process running as the same macOS user: such a process can ask the Keychain too. Short expiry,
revocation, new-IP flags and the audit trail cover that case.

**Repository.** `scripts/check-secrets.mjs` (`pnpm check:secrets`) finds `abt_` tokens whose
checksum matches, so test fixtures and doc examples with a made-up checksum never trip it. It
reports `file:line`, never the token. It runs:

- in the pre-commit hook, on lines added in the index;
- in CI (the Structure job of `ci.yaml`), on every tracked file of the checkout.

The repository is public, so this is the line that matters most. A token that reaches a pushed
commit stays in history: revoke it, which is what makes it harmless.

**Server**

- Tokens are accepted only as `Authorization: Bearer`, never in a cookie or the query string.
- Responses that carry a secret (token creation, the approved poll) are `Cache-Control: no-store`.
- `POST /auth/logout` with a token revokes that token.
- A token is refused (403) on: creating a token, approving or looking up a CLI sign-in, changing
  the password or email, impersonation, and gateway device pairing.

## Code map

| Concern                                                  | Where                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------ |
| Format, checksum, eligibility, rate limit                | `workflows/identity/api-token-format.ts`                                                                                             |
| Token service (mint, list, revoke, resolve, device flow) | `workflows/identity/api-tokens.ts`                                                                                                   |
| Request attribution context                              | `workflows/identity/api-token-context.ts`                                                                                            |
| Store: `adminbot_api_tokens`                             | `persistence/sqlite.ts`, `persistence/postgres-auth.ts`                                                                              |
| Principal resolution                                     | `api/routes/session.ts` (`abt_` bearer, before sessions)                                                                             |
| Routes                                                   | `api/routes/api-tokens.ts` (`/auth/api-tokens*`, `/auth/device/*`)                                                                   |
| UI                                                       | `ui/src/ui/adminbot/views/api-tokens.ts` (token list and CLI approval card), `surfaces/profile.ts`, `app-settings.ts` (`?cliLogin=`) |
| OpenAPI and CLI aliases                                  | `tooling/openapi-routes.ts`, `cli/aliases.mjs` (`auth tokens list                                                                    | revoke | revoke-all`) |
| CLI                                                      | `cli/adminbot.mjs`, `cli/keychain.mjs`, `cli/login.mjs`                                                                              |
| Secret scan                                              | `scripts/check-secrets.mjs`, `git-hooks/pre-commit`, `.github/workflows/ci.yaml`, `test/scripts/check-secrets.test.ts`               |

## Not in scope

- **Scoped (read-only) tokens.** The schema has a `scopes` column, defaulting to `["*"]`, so these
  can be added without a migration.
- **Admin revocation of somebody else's tokens.** Resetting their password does it today.
- **OAuth for third-party apps.**
