"""Close the loop on onboarding nudges: confirm Slack ✅ reactions, re-nudge the rest.

The onboarding nudge DMs ask each member to react with ✅ once they have done the
step (LinkedIn exposes no API that could verify membership for us, so the member's
own reaction is the record — see service-core.ts nudgeOnboardingStep). This script
is the other half, meant for cron. For every member still owing the step it reads
their DM with the bot and

  * marks the step complete through the AdminBot HTTP API when the newest nudge
    carries a confirming reaction from that member,
  * re-nudges when the newest nudge is older than the cadence (or none exists),
  * otherwise leaves them alone until the next run.

Slack itself is the state store: "when did we last nudge" is the timestamp of the
bot's newest nudge message in the DM, so there is no second database to drift out
of sync with either Slack or the roster.

Dry-run is the default on purpose, same contract as adminbot_deadlines.SlackNotifier:
this runs on cron against real people, so pass --live to actually send and record.

Underscored module name (not hyphenated like the other adminbot scripts) so the
tests under test/scripts/ can import it.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import time
import urllib.error
import urllib.request

# Reactions that count as "I've done it". The nudge text sent by the service only
# advertises ✅, but people confirm with whatever thumbs-up-shaped thing is closest.
CONFIRM_REACTIONS = {
    "white_check_mark",
    "heavy_check_mark",
    "ballot_box_with_check",
    "+1",
    "thumbsup",
}

# Every onboarding nudge composed by service-core.ts buildOnboardingNudgeMessage
# contains this phrase; it is how we tell nudges apart from the bot's other DMs
# (deadline reminders share the same conversation).
NUDGE_MARKER = "lab onboarding"


def http_json(
    method: str, url: str, headers: dict, payload: dict | None = None
) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", **headers},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


class AdminBotApi:
    """The two AdminBot routes this script needs, authenticated as the service principal."""

    def __init__(self, base_url: str, token: str, transport=http_json) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"}
        self.transport = transport

    def pending(self, step_id: str) -> dict:
        """{step_id, message, members} — message is the service's own nudge wording."""
        return self.transport(
            "GET", f"{self.base_url}/onboarding/{step_id}/pending", self.headers
        )

    def mark_complete(self, member_id: str, step_id: str) -> None:
        self.transport(
            "POST",
            f"{self.base_url}/lab/members/{member_id}/onboarding/{step_id}",
            self.headers,
            {"complete": True},
        )


class SlackDm:
    """Minimal Slack Web API client for reading and writing the bot's own DMs."""

    def __init__(self, token: str, transport=http_json) -> None:
        self.headers = {"Authorization": f"Bearer {token}"}
        self.transport = transport

    def _call(self, method: str, payload: dict) -> dict:
        result = self.transport(
            "POST", f"https://slack.com/api/{method}", self.headers, payload
        )
        if not result.get("ok"):
            raise RuntimeError(
                f"slack {method} failed: {result.get('error', 'unknown error')}"
            )
        return result

    def open_dm(self, user_id: str) -> str:
        return self._call("conversations.open", {"users": user_id})["channel"]["id"]

    def history(self, channel: str, limit: int = 20) -> list[dict]:
        """Newest-first messages, each with its reactions inline."""
        return self._call(
            "conversations.history", {"channel": channel, "limit": limit}
        )["messages"]

    def post(self, channel: str, text: str) -> None:
        self._call("chat.postMessage", {"channel": channel, "text": text})


def newest_nudge(messages: list[dict]) -> dict | None:
    """The bot's most recent onboarding nudge in a newest-first history, if any."""
    for message in messages:
        if message.get("bot_id") and NUDGE_MARKER in message.get("text", ""):
            return message
    return None


def reaction_confirms(message: dict, member_slack_id: str) -> bool:
    """True when the member themselves put a confirming reaction on the message.

    Checked against the reacting user, not mere presence: in a group context (or if
    the bot ever reacts to its own messages) someone else's ✅ must not complete a
    step on the member's behalf.
    """
    for reaction in message.get("reactions", []):
        confirming = reaction.get("name") in CONFIRM_REACTIONS
        if confirming and member_slack_id in reaction.get("users", []):
            return True
    return False


def process_member(
    api: AdminBotApi,
    slack: SlackDm,
    member: dict,
    step_id: str,
    nudge_text: str,
    cadence_days: float,
    now: float,
    live: bool,
) -> dict:
    outcome = {"member_id": member.get("id"), "name": member.get("name")}
    slack_id = member.get("slack_user_id")
    if not slack_id:
        return {**outcome, "status": "skipped", "reason": "member has no slack_user_id"}
    channel = slack.open_dm(slack_id)
    nudge = newest_nudge(slack.history(channel))
    if nudge and reaction_confirms(nudge, slack_id):
        if live:
            api.mark_complete(member["id"], step_id)
            slack.post(channel, "Got it — recorded as done. ✅")
        return {
            **outcome,
            "status": "confirmed",
            "reason": f"reaction on nudge {nudge['ts']}",
        }
    if nudge:
        age_days = (now - float(nudge["ts"])) / 86400.0
        if age_days < cadence_days:
            return {
                **outcome,
                "status": "waiting",
                "reason": f"nudged {age_days:.1f}d ago",
            }
        if live:
            slack.post(channel, nudge_text)
        return {
            **outcome,
            "status": "renudged",
            "reason": f"last nudge {age_days:.1f}d ago",
        }
    if live:
        slack.post(channel, nudge_text)
    return {**outcome, "status": "renudged", "reason": "no nudge in DM history"}


def poll_step(
    api: AdminBotApi,
    slack: SlackDm,
    step_id: str,
    cadence_days: float,
    now: float,
    live: bool,
) -> dict:
    pending = api.pending(step_id)
    outcomes = [
        process_member(
            api, slack, member, step_id, pending["message"], cadence_days, now, live
        )
        for member in pending["members"]
    ]
    counts: dict[str, int] = {}
    for entry in outcomes:
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
    return {
        "step_id": step_id,
        "mode": "live" if live else "dry-run",
        "counts": counts,
        "outcomes": outcomes,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--step", default="linkedin", help="onboarding step id (default: linkedin)"
    )
    parser.add_argument(
        "--cadence-days",
        type=float,
        default=3.0,
        help="days between re-nudges (default: 3)",
    )
    parser.add_argument(
        "--live", action="store_true", help="actually send DMs and record confirmations"
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("ADMINBOT_BASE_URL", "http://127.0.0.1:8765"),
        help="AdminBot service base URL (default: $ADMINBOT_BASE_URL or http://127.0.0.1:8765)",
    )
    parser.add_argument("--now", help="ISO-8601 timestamp override, for tests")
    args = parser.parse_args(argv)

    service_token = os.environ.get("ADMINBOT_SERVICE_TOKEN")
    if not service_token:
        raise SystemExit(
            "ADMINBOT_SERVICE_TOKEN is required (the AdminBot service principal token)"
        )
    slack_token = os.environ.get("SLACK_BOT_TOKEN")
    if not slack_token:
        raise SystemExit(
            "SLACK_BOT_TOKEN is required (the bot token, needs im:history + chat:write)"
        )

    now = (
        datetime.datetime.fromisoformat(args.now).timestamp()
        if args.now
        else time.time()
    )
    try:
        report = poll_step(
            AdminBotApi(args.base_url, service_token),
            SlackDm(slack_token),
            args.step,
            args.cadence_days,
            now,
            args.live,
        )
    except urllib.error.HTTPError as error:
        # This runs as a cron job whose stdout/stderr is the run summary; the server's own
        # error body ("unknown onboarding step: ...") beats a urllib traceback there.
        detail = error.read().decode("utf-8", "replace").strip()
        raise SystemExit(f"adminbot request failed ({error.code}): {detail}") from error
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
