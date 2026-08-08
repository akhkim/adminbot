export interface CuratedDeadline {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly kind: "conference" | "review" | "workshop";
  readonly label: string;
  readonly occursAtAoe: string;
  readonly sourceUri: string;
  readonly verifiedAt: string;
}

// Curated from official venue schedules. AoE timestamps are stored as wall-clock UTC-12 values.
export const CURATED_DEADLINES: readonly CuratedDeadline[] = [
  {
    id: "neurips-2026-reviewer-discussion",
    name: "NeurIPS 2026 reviewer & AC discussion",
    group: "NeurIPS 2026",
    kind: "review",
    label: "discussion ends",
    occursAtAoe: "2026-08-10T23:59:59-12:00",
    sourceUri: "https://neurips.cc/Conferences/2026/Dates",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "neurips-2026-workshop-submissions",
    name: "NeurIPS 2026 workshop contributions",
    group: "NeurIPS 2026 Workshops",
    kind: "workshop",
    label: "suggested submission date",
    occursAtAoe: "2026-08-29T23:59:59-12:00",
    sourceUri: "https://neurips.cc/Conferences/2026/WorkshopsGuidance",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "emnlp-2026-camera-ready",
    name: "EMNLP 2026 main conference",
    group: "EMNLP 2026",
    kind: "conference",
    label: "camera-ready papers due",
    occursAtAoe: "2026-08-30T23:59:59-12:00",
    sourceUri: "https://2026.emnlp.org/calls/main_conference_papers/",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "arr-2026-august-reviews",
    name: "ARR August 2026 cycle",
    group: "ACL Rolling Review",
    kind: "review",
    label: "reviews due",
    occursAtAoe: "2026-09-07T23:59:59-12:00",
    sourceUri: "https://aclrollingreview.org/dates",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "neurips-2026-notification",
    name: "NeurIPS 2026 main conference",
    group: "NeurIPS 2026",
    kind: "conference",
    label: "author notification",
    occursAtAoe: "2026-09-24T23:59:59-12:00",
    sourceUri: "https://neurips.cc/Conferences/2026/Dates",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "arr-2026-august-response",
    name: "ARR August 2026 cycle",
    group: "ACL Rolling Review",
    kind: "review",
    label: "author response ends",
    occursAtAoe: "2026-09-24T23:59:59-12:00",
    sourceUri: "https://aclrollingreview.org/dates",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "neurips-2026-workshop-notification",
    name: "NeurIPS 2026 workshops",
    group: "NeurIPS 2026 Workshops",
    kind: "workshop",
    label: "mandatory notification date",
    occursAtAoe: "2026-09-29T23:59:59-12:00",
    sourceUri: "https://neurips.cc/Conferences/2026/WorkshopsGuidance",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "eacl-2027-commitment",
    name: "EACL 2027",
    group: "EACL 2027",
    kind: "conference",
    label: "ARR commitment",
    occursAtAoe: "2026-10-11T23:59:59-12:00",
    sourceUri: "https://aclrollingreview.org/dates",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
  {
    id: "arr-2026-october-submission",
    name: "ARR October 2026 cycle",
    group: "ACL Rolling Review",
    kind: "conference",
    label: "submission",
    occursAtAoe: "2026-10-12T23:59:59-12:00",
    sourceUri: "https://aclrollingreview.org/dates",
    verifiedAt: "2026-08-08T00:00:00Z",
  },
] as const;
