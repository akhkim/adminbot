import { describe, expect, it } from "vitest";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  matchTopicChannels,
  memberTopicVocabulary,
  topicOfChannel,
  topicTokens,
} from "./topic-channels.js";

const member = (overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember =>
  ({ id: "ada", name: "Ada", privilege_level: "member", ...overrides }) as AdminBotLabMember;

const paper = (overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord =>
  ({
    id: "p1",
    title: "A paper",
    authors: ["Ada"],
    author_links: [{ name: "Ada", member_id: "ada" }],
    current_step: "brainstorming_docs",
    ...overrides,
  }) as AdminBotPaperRecord;

describe("topicOfChannel", () => {
  it("reads the topic off the channel name", () => {
    expect(topicOfChannel("#discussion-causal-inference")).toEqual({
      prefix: "discussion",
      topic: "causal-inference",
    });
    expect(topicOfChannel("meeting-nlp")).toEqual({ prefix: "meeting", topic: "nlp" });
  });

  // The lab decides its topics by opening channels; anything else is not one of ours.
  it("ignores channels outside the two families", () => {
    expect(topicOfChannel("proj-cais")).toBeNull();
    expect(topicOfChannel("jinesis-active")).toBeNull();
    expect(topicOfChannel("discussion-")).toBeNull();
  });
});

describe("topicTokens", () => {
  it("keeps words of four letters or more and drops the ones that carry no topic", () => {
    expect(topicTokens("Causal Inference and the Lab")).toEqual(["causal", "inference"]);
    // "llm" is three letters. Dropping it is the cost of the length rule, and it is the right
    // trade: two- and three-letter tokens match almost anything.
    expect(topicTokens("LLM safety")).toEqual(["safety"]);
  });
});

describe("memberTopicVocabulary", () => {
  // Both signals: what they say they work on, and what they are actually on.
  it("draws on research interests and the projects they are an author of", () => {
    const vocabulary = memberTopicVocabulary(
      member({ research_topics: ["causal inference"] }),
      [paper({ title: "Mechanism Design for Agents", alias: "alg-circuit" })],
    );
    expect(vocabulary).toEqual(
      expect.arrayContaining(["causal", "inference", "mechanism", "design", "agents", "circuit"]),
    );
  });

  // A hyphenated alias reads as its words, not one token nothing can match.
  it("splits an alias on its hyphens", () => {
    expect(memberTopicVocabulary(member(), [paper({ alias: "causal-tutor" })])).toEqual(
      expect.arrayContaining(["causal", "tutor"]),
    );
  });

  it("ignores papers the member is not an author of", () => {
    const other = paper({ author_links: [{ name: "Bob", member_id: "bob" }] });
    expect(memberTopicVocabulary(member(), [other])).toEqual([]);
  });
});

describe("matchTopicChannels", () => {
  const channels = [
    "discussion-causal-inference",
    "discussion-mechanism-design",
    "discussion-multimodal",
    "meeting-causal-inference",
    "proj-cais",
  ];

  it("matches a channel whose every topic word the person uses", () => {
    expect(
      matchTopicChannels({
        member: member({ research_topics: ["causal inference for agents"] }),
        papers: [],
        channels,
      }),
    ).toEqual(["discussion-causal-inference", "meeting-causal-inference"]);
  });

  // The conservative half of the rule, and the reason for it: a person who works on inference but
  // not causality should not be pulled into #discussion-causal-inference on one shared word.
  it("does not match on a partial overlap", () => {
    expect(
      matchTopicChannels({
        member: member({ research_topics: ["variational inference"] }),
        papers: [],
        channels,
      }),
    ).toEqual([]);
  });

  it("can be narrowed to one family", () => {
    expect(
      matchTopicChannels({
        member: member({ research_topics: ["causal inference"] }),
        papers: [],
        channels,
        prefix: "meeting",
      }),
    ).toEqual(["meeting-causal-inference"]);
  });

  it("matches on a project the person is on, not only on stated interests", () => {
    expect(
      matchTopicChannels({
        member: member(),
        papers: [paper({ title: "Mechanism Design for Markets" })],
        channels,
      }),
    ).toEqual(["discussion-mechanism-design"]);
  });

  // A topic that reduces to nothing must match nobody. `every` on an empty list is true, which
  // would otherwise put the entire lab in it.
  it("never matches a channel whose topic is all stopwords", () => {
    expect(
      matchTopicChannels({
        member: member({ research_topics: ["causal inference"] }),
        papers: [],
        channels: ["discussion-misc", "discussion-general"],
      }),
    ).toEqual([]);
  });

  it("matches nobody when the lab knows nothing about what they work on", () => {
    expect(matchTopicChannels({ member: member(), papers: [], channels })).toEqual([]);
  });
});
