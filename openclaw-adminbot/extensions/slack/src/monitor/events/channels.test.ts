// Slack tests cover channels plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
let registerSlackChannelEvents: typeof import("./channels.js").registerSlackChannelEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));
type SlackChannelHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createChannelContext(params?: {
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  onChannelNamingEvent?: (event: {
    eventType: "channel_created" | "channel_rename";
    channelId?: string;
    channelName?: string;
    ownerUserId?: string;
    purpose?: string;
    topic?: string;
  }) => Promise<void>;
}) {
  const harness = createSlackSystemEventTestHarness();
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackChannelEvents({
    ctx: harness.ctx,
    trackEvent: params?.trackEvent,
    onChannelNamingEvent: params?.onChannelNamingEvent,
  });
  return {
    getCreatedHandler: () => harness.getHandler("channel_created") as SlackChannelHandler | null,
    getRenamedHandler: () => harness.getHandler("channel_rename") as SlackChannelHandler | null,
  };
}

function requireChannelHandler(handler: SlackChannelHandler | null): SlackChannelHandler {
  if (!handler) {
    throw new Error("expected Slack channel_created handler");
  }
  return handler;
}

describe("registerSlackChannelEvents", () => {
  beforeAll(async () => {
    ({ registerSlackChannelEvents } = await import("./channels.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const createdHandler = requireChannelHandler(getCreatedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("tracks accepted events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({ trackEvent });
    const createdHandler = requireChannelHandler(getCreatedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Slack channel created: #general.", {
      sessionKey: "agent:main:main",
      contextKey: "slack:channel:created:C1",
    });
  });

  it("forwards channel lifecycle events to optional naming callback", async () => {
    const onChannelNamingEvent = vi.fn(async () => {});
    const { getCreatedHandler, getRenamedHandler } = createChannelContext({ onChannelNamingEvent });
    const createdHandler = requireChannelHandler(getCreatedHandler());
    const renamedHandler = requireChannelHandler(getRenamedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "eu-post-training", creator: "U1" },
      },
      body: {},
    });
    await renamedHandler({
      event: {
        channel: { id: "C1", name: "proj-eu-post-training" },
      },
      body: {},
    });

    expect(onChannelNamingEvent).toHaveBeenNthCalledWith(1, {
      eventType: "channel_created",
      channelId: "C1",
      channelName: "eu-post-training",
      ownerUserId: "U1",
      purpose: undefined,
      topic: undefined,
    });
    expect(onChannelNamingEvent).toHaveBeenNthCalledWith(2, {
      eventType: "channel_rename",
      channelId: "C1",
      channelName: "proj-eu-post-training",
    });
  });
});
