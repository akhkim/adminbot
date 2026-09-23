# References-Validation / CheckIfExist

Source: https://github.com/zabbonat/References-Validation
Pinned commit: `e4605651751f53579e57a0e14159c2f93b3f5e31`.
Copyright 2026 Diletta Abbonato. MIT license, reproduced in LICENSE.

This directory vendors the upstream search services, plain-text parser, and reference-section
recognition/splitting functions. Upstream is an application without a published library API;
keeping a pinned copy avoids installing its React/Electron application in the service.

Local adaptations:
- Kebab-case filenames, explicit `.js` imports, mechanical lint fixes and repository formatting.
- Fetch uses the request-scoped AdminBot adapter for host restrictions, timeouts, rate limiting,
  response bounds and failure reporting; no global monkey-patch.
- Pending fallback requests are awaited so failures and cancellation are accounted for.
- arXiv is contacted directly, without public CORS proxies. Atom XML uses fast-xml-parser
  instead of browser DOMParser. No manuscript/citation logging.
- Appendix headings with suffixes (for example, “Appendix A: Details” and lettered “A APPENDIX”) end the reference section. Unnumbered year-ending citations
  are split, year-only lines are not mistaken for reference numbers, review headers removed, and oversized entries retained for fail-closed validation.
- A lone capital initial followed by a period (“Aidan N. Gomez”) no longer ends a segment in the
  plain-text parser, and an author list ending “…, B, and C” is recognized as authors; without
  both, the author list was taken for the title. Commas are removed from
  OpenAlex title filters, where they separate filters and made the request fail.
- Reference splitting was rebuilt around real conference PDFs, where upstream failed 16 of 20
  (the lab's submissions are mostly ACL/EMNLP/ARR and ICLR/NeurIPS): PDFium's U+FFFE hyphen
  marks and \r are normalized; author-year bibliographies without labels or blank lines are split
  where the text up to the next year (or first sentence) is a list of names; ICLR back-references
  ("… 2019. 1, 6") end an entry; alphabetic labels ("[CCE+ 18]"), wrapped or run together, are
  labels; numbered mode requires the bibliography to start with a label; lettered appendix,
  checklist and limitations headings end the section unless more entries follow; and appendix
  prose run onto the last entry is cut back.
- The plain-text parser takes the sentence after the year as an ACL entry's title, and penalizes
  "In …", page ranges, reports and preprints as venues, where it picked the venue as the title.
- PDF/DOCX browser loading is omitted; AdminBot uses its existing clawpdf version on the server.
- Predatory-journal classification and the separately sourced publisher list are omitted.
  The checker reports matching metadata and retraction information, not publisher judgments.

When updating, compare these adaptations with the pinned upstream revision and run the connector
and HTTP tests. Upstream match scores are heuristics, not probabilities of fabrication.
