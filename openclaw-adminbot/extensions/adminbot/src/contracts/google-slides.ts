// The slice of the Google Slides REST API the working-groups sync reads and writes. Hand-written
// rather than generated: only these fields are read, and naming them here is what lets the pure
// planner be tested against plain objects without a Google client in sight.

export const EMU_PER_INCH = 914_400;
// Slides reports some magnitudes in points (text boxes made in the editor often are).
export const EMU_PER_POINT = 12_700;

export type SlidesDimension = { magnitude?: number; unit?: string };
export type SlidesSize = { width?: SlidesDimension; height?: SlidesDimension };

export type SlidesAffineTransform = {
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
  translateX?: number;
  translateY?: number;
  unit?: string;
};

export type SlidesRgbColor = { red?: number; green?: number; blue?: number };

export type SlidesOutline = {
  outlineFill?: { solidFill?: { color?: { rgbColor?: SlidesRgbColor }; alpha?: number } };
  weight?: SlidesDimension;
  dashStyle?: string;
  propertyState?: string;
};

export type SlidesTextElement = { textRun?: { content?: string } };

export type SlidesPageElement = {
  objectId: string;
  size?: SlidesSize;
  transform?: SlidesAffineTransform;
  title?: string;
  description?: string;
  shape?: {
    shapeType?: string;
    placeholder?: { type?: string };
    text?: { textElements?: SlidesTextElement[] };
  };
  image?: {
    contentUrl?: string;
    sourceUrl?: string;
    imageProperties?: { cropProperties?: Record<string, number>; outline?: SlidesOutline };
  };
  elementGroup?: { children?: SlidesPageElement[] };
};

export type SlidesPage = { objectId: string; pageElements?: SlidesPageElement[] };

export type SlidesPresentation = {
  presentationId: string;
  revisionId?: string;
  pageSize?: SlidesSize;
  slides?: SlidesPage[];
};

// The only request kinds the sync ever sends. A union rather than `Record<string, unknown>` so the
// executor can refuse anything else by construction, not by string matching. There is no move:
// the slide is curated by hand, and the sync only ever appends after the faces already there.
export type SlidesCreateImageRequest = {
  createImage: {
    objectId: string;
    url: string;
    elementProperties: {
      pageObjectId: string;
      size: { width: { magnitude: number; unit: "EMU" }; height: { magnitude: number; unit: "EMU" } };
      transform: Required<Omit<SlidesAffineTransform, "unit">> & { unit: "EMU" };
    };
  };
};

/** Labels a new face with its member, which is what marks it as one this sync may later touch. */
export type SlidesAltTextRequest = {
  updatePageElementAltText: { objectId: string; title: string; description: string };
};

export type SlidesDeleteObjectRequest = { deleteObject: { objectId: string } };

export type SlidesFaceRequest = SlidesCreateImageRequest | SlidesAltTextRequest | SlidesDeleteObjectRequest;

/** The ring around the existing faces, as a fraction of a face's width, so a new face matches. */
export type FaceRing = { red: number; green: number; blue: number; width_ratio: number };

/** One face to render: the executor turns the avatar into a round PNG before Slides fetches it. */
export type SlidesFaceImage = {
  object_id: string;
  member_id: string;
  avatar_url: string;
  ring: FaceRing | null;
};

/** What the approver signs: the exact requests plus what the slide looked like when planned. */
export type AdminBotSlidesWorkingGroupsPayload = {
  presentation_id: string;
  slide_object_id: string;
  requests: SlidesFaceRequest[];
  // Where every face being deleted sat at planning time. The deck is edited by hand, so the
  // executor re-reads it and refuses if any of these drifted, rather than pinning the whole
  // presentation revision and failing on every unrelated typo fix.
  expected: Array<{ object_id: string; translate_x: number; translate_y: number }>;
  faces: SlidesFaceImage[];
  groups: Array<{
    group: string;
    title: string;
    status: string;
    added: string[];
    removed: string[];
    /** Faces this sync placed for people no longer in the group: deleted only with the opt-in. */
    would_remove: string[];
    /** People who belong but do not fit in the box; nobody is added to a box that is full. */
    no_room: string[];
    skipped_no_photo: string[];
    face_size_in: number;
  }>;
};

/** Read and write access to one presentation. Injected so tests never reach Google. */
export type GoogleSlidesClient = {
  getPresentation(presentationId: string): Promise<SlidesPresentation>;
  batchUpdate(presentationId: string, requests: readonly SlidesFaceRequest[]): Promise<unknown>;
};

/** Everything the service needs to plan the working-groups slide. Absent means "not configured". */
export type SlidesWorkingGroupsSource = {
  presentationId: string;
  slideTitle: string;
  client: Pick<GoogleSlidesClient, "getPresentation">;
  /**
   * Delete faces this sync placed for people who have left the group. Off by default: the plan
   * still lists them under "would remove", and nothing placed by hand is ever deleted either way.
   */
  allowRemovals?: boolean;
  /**
   * Approve and write an append-only plan as soon as it is made, so the slide keeps itself
   * current with nobody watching the queue. A plan that deletes anything still waits for an admin.
   */
  autoApply?: boolean;
  /** How long a burst of profile saves is coalesced before one sync is proposed. */
  debounceMs?: number;
};
