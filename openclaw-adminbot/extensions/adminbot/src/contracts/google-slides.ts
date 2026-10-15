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
    imageProperties?: { cropProperties?: Record<string, number> };
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

// The only three request kinds the sync ever sends. A union rather than `Record<string, unknown>`
// so the executor can refuse anything else by construction, not by string matching.
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

export type SlidesUpdateTransformRequest = {
  updatePageElementTransform: {
    objectId: string;
    applyMode: "ABSOLUTE";
    transform: Required<Omit<SlidesAffineTransform, "unit">> & { unit: "EMU" };
  };
};

export type SlidesDeleteObjectRequest = { deleteObject: { objectId: string } };

export type SlidesFaceRequest =
  | SlidesCreateImageRequest
  | SlidesUpdateTransformRequest
  | SlidesDeleteObjectRequest;

/** What the approver signs: the exact requests plus what the slide looked like when planned. */
export type AdminBotSlidesWorkingGroupsPayload = {
  presentation_id: string;
  slide_object_id: string;
  requests: SlidesFaceRequest[];
  // Where every moved or deleted face sat at planning time. The deck is edited by hand, so the
  // executor re-reads it and refuses if any of these drifted, rather than pinning the whole
  // presentation revision and failing on every unrelated typo fix.
  expected: Array<{ object_id: string; translate_x: number; translate_y: number }>;
  groups: Array<{
    group: string;
    title: string;
    status: string;
    added: string[];
    removed: string[];
    moved: number;
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
   * Turns a member's avatar URL into the URL Slides should fetch. Identity by default; a
   * deployment may route it through an image proxy that crops a circle, since the Slides API has
   * no way to apply the round mask the hand-placed faces use.
   */
  faceImageUrl?: (avatarUrl: string) => string;
  /** How long a burst of profile saves is coalesced before one sync is proposed. */
  debounceMs?: number;
};
