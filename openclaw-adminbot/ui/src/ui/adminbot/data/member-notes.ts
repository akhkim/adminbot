// Shared convention for encoding extra lab-member profile fields into the single
// free-text `notes` column. There is no server-side schema for these — they only
// exist as this client-side line-based convention, read/written identically by
// the admin Lab Members editor and the member-facing self-edit form.
export type MemberNoteDraft = {
  location: string;
  joinedMonth: string;
  researchInterests: string;
  calendarEmail: string;
  whatsapp: string;
  github: string;
  website: string;
  notes: string;
};

export function noteField(notes: string | undefined, key: string): string {
  const expected = key.toLowerCase();
  for (const line of (notes ?? "").split("\n")) {
    const [rawKey, ...rest] = line.trim().split(":");
    if (rawKey?.trim().toLowerCase() === expected) {
      return rest.join(":").trim();
    }
  }
  return "";
}

export function parseMemberNotes(notes: string | undefined): MemberNoteDraft {
  const draft: MemberNoteDraft = {
    location: "",
    joinedMonth: "",
    researchInterests: "",
    calendarEmail: "",
    whatsapp: "",
    github: "",
    website: "",
    notes: "",
  };
  const leftovers: string[] = [];
  for (const line of (notes ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [rawKey, ...rest] = trimmed.split(":");
    const value = rest.join(":").trim();
    switch (rawKey.toLowerCase()) {
      case "location":
        draft.location = value;
        break;
      case "joined month":
        draft.joinedMonth = value;
        break;
      case "research interests":
        draft.researchInterests = value;
        break;
      case "gmail for calendar":
        draft.calendarEmail = value;
        break;
      case "whatsapp":
        draft.whatsapp = value;
        break;
      case "github":
        draft.github = value;
        break;
      case "personal website":
        draft.website = value;
        break;
      default:
        leftovers.push(trimmed);
        break;
    }
  }
  draft.notes = leftovers.join("\n");
  return draft;
}

export function buildMemberNotes(draft: MemberNoteDraft): string | undefined {
  const lines = [
    ["Location", draft.location],
    ["Joined month", draft.joinedMonth],
    ["Research interests", draft.researchInterests],
    ["Gmail for calendar", draft.calendarEmail],
    ["WhatsApp", draft.whatsapp],
    ["GitHub", draft.github],
    ["Personal website", draft.website],
  ]
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`);
  if (draft.notes.trim()) {
    lines.push(draft.notes.trim());
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
