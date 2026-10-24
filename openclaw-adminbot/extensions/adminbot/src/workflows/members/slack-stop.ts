// "stop" in a Slack DM to AdminBot: the opt-out that needs no portal, no form and no admin.
//
// A member who is tired of intros and nice-to-have nudges answers the bot the way they would any
// SMS list. The reply is matched here, before any model sees it, so the answer is the same every
// time and the record changes whatever the agent would have said. Only a message that is nothing
// but the command counts: "stop sending me the EMNLP reminders please" is a conversation, and the
// agent answers it.
//
// What "stop" covers: every meetup intro (event and city) and every nudge marked `optional`.
// What it does not: reminders about the member's own papers, reviews and onboarding, which are
// lab work rather than outreach; an admin's do_not_contact remains the way to silence those.

export type SlackStopCommand = "stop" | "start";

const STOP = new Set([
  "stop",
  "stop all",
  "unsubscribe",
  "opt out",
  "optout",
  "opt-out",
  "stop intros",
  "stop messages",
  "mute",
]);
const START = new Set(["start", "unstop", "resume", "subscribe", "opt in", "optin", "opt-in"]);

/** The command a DM is, or undefined when it is anything more than the command itself. */
export function parseSlackStopCommand(text: string | undefined): SlackStopCommand | undefined {
  const word = (text ?? "")
    .toLowerCase()
    .replace(/[.!\s]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (STOP.has(word)) {
    return "stop";
  }
  return START.has(word) ? "start" : undefined;
}

/** What AdminBot says back. One message, once per command. */
export function slackStopReply(command: SlackStopCommand, alreadySet: boolean): string {
  if (command === "stop") {
    return alreadySet
      ? "You're already opted out. Reply *start* any time to turn intros and optional reminders back on."
      : "Done: no more intros or optional reminders from AdminBot. Reminders about your own papers, reviews and onboarding still come through. Reply *start* to undo.";
  }
  return alreadySet
    ? "Done: intros and optional reminders are back on. Reply *stop* to turn them off again."
    : "You weren't opted out, so nothing changed. Reply *stop* to turn off intros and optional reminders.";
}
