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
- PDF/DOCX browser loading is omitted; AdminBot uses its existing clawpdf version on the server.
- Predatory-journal classification and the separately sourced publisher list are omitted.
  The checker reports matching metadata and retraction information, not publisher judgments.

When updating, compare these adaptations with the pinned upstream revision and run the connector
and HTTP tests. Upstream match scores are heuristics, not probabilities of fabrication.
