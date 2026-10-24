import { describe, expect, it } from "vitest";
import { parseSlackStopCommand, slackStopReply } from "./slack-stop.js";

describe("parseSlackStopCommand", () => {
  it.each(["stop", "STOP", " Stop! ", "unsubscribe", "Opt out", "opt-out", "optout.", "mute"])(
    "reads %j as stop",
    (text) => expect(parseSlackStopCommand(text)).toBe("stop"),
  );

  it.each(["start", "START", "resume", "opt in", "Subscribe!"])("reads %j as start", (text) =>
    expect(parseSlackStopCommand(text)).toBe("start"),
  );

  it.each([
    "",
    undefined,
    "stop sending me the EMNLP reminders please",
    "can you stop?",
    "no more",
    "starting the draft now",
  ])("leaves %j to the agent", (text) => expect(parseSlackStopCommand(text)).toBeUndefined());
});

describe("slackStopReply", () => {
  it("says how to undo, and that lab-work reminders still come", () => {
    const stop = slackStopReply("stop", false);
    expect(stop).toContain("*start*");
    expect(stop).toMatch(/papers, reviews and onboarding/u);
    expect(slackStopReply("start", true)).toContain("*stop*");
  });

  it("does not claim a change that did not happen", () => {
    expect(slackStopReply("stop", true)).toMatch(/already opted out/u);
    expect(slackStopReply("start", false)).toMatch(/nothing changed/u);
  });
});
