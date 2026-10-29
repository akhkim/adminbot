/**
 * Recognise a delivery-failure notice (a bounce) without consulting the model.
 *
 * A bounce is mail AdminBot itself sent coming back: a password reset, an onboarding guide, a
 * nudge. The classifier has no category for one, so before this every bounce came out `unknown`
 * and was parked in the review queue as "an automated delivery status notification", which says
 * nothing a reviewer can act on. What they need is who the mail was for and what the remote
 * server said, so the member record with the dead address can be fixed. Both are on fixed lines
 * of the notice, so a pattern is cheaper and more reliable than a 122B model call.
 */

export type DeliveryFailure = {
  /** Lower-cased addresses the notice says could not be reached, in the order they appear. */
  recipients: string[];
  /** The remote server's reply ("550 5.1.1 ... user unknown"), when the notice quotes one. */
  diagnostic?: string;
};

// Who sends bounces. Gmail's is mailer-daemon@googlemail.com; Exchange and Postfix use
// postmaster@ or MAILER-DAEMON@ on the sending domain.
const BOUNCE_SENDER = /^(mailer-daemon|postmaster|mail-daemon)@/iu;

// Subjects the common MTAs put on a failure notice. A sender match alone is not enough: a
// postmaster also sends delay warnings ("Delivery Status Notification (Delay)"), which are not
// failures and resolve themselves.
const BOUNCE_SUBJECT =
  /delivery status notification \(failure\)|undeliverable|undelivered mail|mail delivery (failed|failure)|returned mail|delivery (has )?failed|failure notice/iu;

const ADDRESS = String.raw`<?([a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,})>?`;

// The lines that name the recipient, most specific first. Gmail writes prose ("wasn't delivered to
// x because", "Your message to x has been blocked"); RFC 3464 notices carry Final-Recipient.
const RECIPIENT_PATTERNS = [
  new RegExp(String.raw`wasn['’]t delivered to\s+${ADDRESS}`, "giu"),
  new RegExp(String.raw`your message to\s+${ADDRESS}\s+(?:has been|was) blocked`, "giu"),
  new RegExp(String.raw`(?:final|original)-recipient:\s*rfc822;\s*${ADDRESS}`, "giu"),
  new RegExp(String.raw`delivery (?:to the following recipients?|has) failed[^\n]*\n\s*${ADDRESS}`, "giu"),
];

const DIAGNOSTIC_PATTERNS = [
  /diagnostic-code:\s*smtp;\s*([^\n]+)/iu,
  // Gmail quotes the remote server under "The response from the remote server was:".
  /the response (?:from the remote server )?was:\s*\n\s*([^\n]+)/iu,
  // A bare SMTP reply line: three-digit permanent code, optional enhanced status code.
  /^\s*(5\d\d[ -](?:\d\.\d{1,3}\.\d{1,3}\s+)?[^\n]+)$/imu,
];

/**
 * The failure a bounce reports, or undefined when the mail is not a failure notice.
 *
 * Returns undefined for a bounce that names no recipient as well: there is nothing to say about
 * one of those that the classifier's `unknown` does not already say, so it keeps the old path.
 */
export function parseDeliveryFailure(message: {
  from: string;
  subject: string;
  body: string;
}): DeliveryFailure | undefined {
  if (!BOUNCE_SENDER.test(message.from.trim()) || !BOUNCE_SUBJECT.test(message.subject)) {
    return undefined;
  }
  const recipients: string[] = [];
  for (const pattern of RECIPIENT_PATTERNS) {
    for (const match of message.body.matchAll(pattern)) {
      const address = match[1].toLowerCase();
      if (!recipients.includes(address)) recipients.push(address);
    }
  }
  if (recipients.length === 0) return undefined;
  const diagnostic = DIAGNOSTIC_PATTERNS.map((pattern) => pattern.exec(message.body)?.[1])
    .find((line) => line?.trim())
    ?.trim()
    .slice(0, 300);
  return diagnostic ? { recipients, diagnostic } : { recipients };
}

/** The review-queue reason for a bounce: who it was for and what their server said. */
export function deliveryFailureReason(failure: DeliveryFailure): string {
  const who = failure.recipients.join(", ");
  const why = failure.diagnostic ? ` (${failure.diagnostic})` : "";
  return `Mail AdminBot sent to ${who} bounced${why}. Check the member record that holds this address and correct it, then resend whatever bounced.`;
}
