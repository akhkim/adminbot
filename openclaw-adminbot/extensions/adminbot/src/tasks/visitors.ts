import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

export const VISITOR_COOKIE = "adminbot_visitor";
const LIFETIME_MS = 24 * 60 * 60 * 1000;

/** A visitor credential grants only reimbursement tasks, never a member principal. */
export class VisitorSessions {
  constructor(
    private readonly db: DatabaseSync,
    persist = false,
    private readonly now = Date.now,
  ) {
    db.exec(`CREATE ${persist ? "" : "TEMP "}TABLE IF NOT EXISTS adminbot_task_visitors (
      token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
  }

  resolve(req: IncomingMessage): string | undefined {
    const token = visitorToken(req);
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      return undefined;
    }
    const row = this.db
      .prepare("SELECT owner FROM adminbot_task_visitors WHERE token_hash = ? AND expires_at > ?")
      .get(createHash("sha256").update(token).digest("hex"), this.now()) as
      | { owner: string }
      | undefined;
    return row?.owner;
  }

  ensure(req: IncomingMessage, res: ServerResponse): string {
    const existing = this.resolve(req);
    if (existing) {
      // Bootstrap reattaches an existing cookie or header credential without creating a new owner.
      res.setHeader("X-AdminBot-Visitor", visitorToken(req)!);
      return existing;
    }
    this.db.prepare("DELETE FROM adminbot_task_visitors WHERE expires_at <= ?").run(this.now());
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM adminbot_task_visitors").get() as {
      count: number;
    };
    if (count.count >= 10_000) {
      throw new Error("visitor session capacity reached; try again later");
    }
    const token = randomBytes(32).toString("base64url");
    const owner = `visitor:${randomUUID()}`;
    this.db
      .prepare("INSERT INTO adminbot_task_visitors(token_hash, owner, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), owner, this.now() + LIFETIME_MS);
    res.setHeader("X-AdminBot-Visitor", token);
    const secure = "encrypted" in req.socket && req.socket.encrypted ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${VISITOR_COOKIE}=${token}; Path=/; Max-Age=${LIFETIME_MS / 1000}; HttpOnly; SameSite=Strict${secure}`,
    );
    return owner;
  }
}

function visitorToken(req: IncomingMessage): string | undefined {
  const visitorHeader = req.headers["x-adminbot-visitor"];
  return (
    (typeof visitorHeader === "string" ? visitorHeader : undefined) ??
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${VISITOR_COOKIE}=`))
      ?.slice(VISITOR_COOKIE.length + 1)
  );
}
