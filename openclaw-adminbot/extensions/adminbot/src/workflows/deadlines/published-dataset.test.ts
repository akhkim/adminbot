import { expect, it } from "vitest";
import type { PublishedDeadlineRecord } from "../../contracts/deadline-proposals.js";
import { mergePublishedDeadlines } from "./published-dataset.js";

const fullId = "community_f43e7729-6593-4aed-90fd-fca5ff390806";
const abstractId = "icml2027_abstract";
const initial: PublishedDeadlineRecord = {
  action_id: "initial",
  proposal_id: "initial",
  deadline_id: fullId,
  revision: 1,
  published_at: "2026-11-14T00:00:00Z",
  published_by_member_id: "member-1",
  deadline: {
    name: "ICML 2027 Main Track",
    parentConference: "ICML",
    parentYear: "2027",
    entryType: "main_conference",
    deadlineDate: "2027-01-22",
    deadlineTime: "23:59",
    timezone: "Etc/GMT+12",
    homepageUrl: "https://icml.cc/Conferences/2027",
    cfpUrl: "https://icml.cc/Conferences/2027/CallForPapers",
    openReviewUrl: "",
    note: "",
  },
};

it("uses the collector after a manual addition and preserves reviewed date changes", () => {
  const generated = {
    id: fullId,
    name: "ICML 2027 Main Track",
    deadline_aoe: "2027-01-23 23:59:00",
    abstract_deadline_id: abstractId,
    schedule: [],
  };
  const abstract = { id: abstractId, deadline_aoe: "2027-01-14 23:59:00" };
  const stage: PublishedDeadlineRecord = {
    ...initial,
    action_id: "abstract",
    deadline: {
      ...initial.deadline,
      deadlineDate: "2027-01-14",
      stage: {
        venueId: fullId,
        operation: "add",
        milestone: "abstract",
        label: "Abstract submission",
      },
    },
  };
  expect(mergePublishedDeadlines([generated, abstract], [initial, stage])).toEqual([
    generated,
    abstract,
  ]);
  expect(mergePublishedDeadlines([], [initial, stage])).toMatchObject([
    { deadline_aoe: "2027-01-22 23:59:00", schedule: [{ milestone: "abstract" }] },
  ]);
  const correction = {
    ...initial,
    published_at: "2026-11-30T00:00:00Z",
    previous_deadline_aoe: "2027-01-23 23:59:00",
    deadline: { ...initial.deadline, deadlineDate: "2027-01-24" },
  };
  expect(mergePublishedDeadlines([generated], [initial, correction])).toMatchObject([
    { deadline_aoe: "2027-01-24 23:59:00", deadline_source_status: "administrator_approved" },
  ]);
});

it("shows known archival main conferences and ARR commitments without assuming custom venues are archival", () => {
  const input = (family: string, entryType: PublishedDeadlineRecord["deadline"]["entryType"]) => ({
    ...initial,
    deadline: { ...initial.deadline, parentConference: family, entryType },
  });
  expect(mergePublishedDeadlines([], [input("ICML", "main_conference")])).toMatchObject([
    { entry_type: "main_conference", archival: true, archival_status: "archival" },
  ]);
  expect(mergePublishedDeadlines([], [input("COLING", "arr_commitment")])).toMatchObject([
    { entry_type: "arr_commitment", archival: true, archival_status: "archival" },
  ]);
  expect(mergePublishedDeadlines([], [input("Example", "main_conference")])).toMatchObject([
    { archival: false, archival_status: "unknown" },
  ]);
  expect(mergePublishedDeadlines([], [input("ICML", "workshop")])).toMatchObject([
    { archival: false, archival_status: "unknown" },
  ]);
});
