// The named steps a paper moves through. Active Papers and My Projects & Papers both read them
// here, so the pages cannot disagree about where a paper is -- and neither has to load the other.

import type { AdminBotPaperStep } from "../controllers/admin.ts";

export const stepLabels: Record<string, string> = {
  brainstorming_docs: "Brainstorming docs",
  overleaf_writing: "Overleaf writing",
  submission: "Submission",
  google_drive_pdf: "Drive PDF",
  arxiv_polish: "arXiv polish",
  social_posts: "Social posts",
  slide_making: "Slides",
  poster_making: "Poster",
};

export const paperSteps: AdminBotPaperStep[] = [
  "brainstorming_docs",
  "overleaf_writing",
  "submission",
  "google_drive_pdf",
  "arxiv_polish",
  "social_posts",
  "slide_making",
  "poster_making",
];
