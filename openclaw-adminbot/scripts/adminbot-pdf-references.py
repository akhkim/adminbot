#!/usr/bin/env python3
"""Extract the bibliography text out of a paper PDF.

PaperMentor's CitationVerifier reads a project's .bib file, where every entry is already
structured. OpenReview only hands out the compiled PDF, so this script recovers the raw
reference block and the caller turns it into entries. It deliberately stops at text: deciding
where one reference ends and the next begins is a language judgement, and the local model does
that downstream with a JSON schema.

pypdfium2 ships PDFium as a self-contained wheel, so this works on Aurora without root.
"""

import argparse
import json
import re
import sys

import pypdfium2

# The bibliography is the last such heading in the document: papers cite "References" in body
# text, and an appendix can follow the reference list, so scanning from the end is what finds
# the real start.
#
# The trailing [\s\d.]* is load-bearing, not symmetry with the leading one. ACL/ARR submission
# PDFs carry margin line numbers, and PDFium extracts them inline, so the heading arrives as
# "References 743" rather than "References". Anchoring on a bare heading missed 6 of 16 real
# submissions.
HEADING_RE = re.compile(
    r"^[\s\d.]*(references|bibliography|works cited|literature cited)[\s\d.]*$",
    re.IGNORECASE | re.MULTILINE,
)
# Appendices routinely follow the references; anything past one of these is not a citation.
END_RE = re.compile(
    r"^[\s\d.]*(appendi(x|ces)|supplementary material|a\.?\s+appendix)\b",
    re.IGNORECASE | re.MULTILINE,
)


def page_texts(path: str) -> list[str]:
    try:
        pdf = pypdfium2.PdfDocument(path)
    except Exception as error:  # PdfiumError for corrupt/encrypted input
        raise SystemExit(json.dumps({"ok": False, "reason": "unreadable_pdf", "error": str(error)}))
    try:
        pages = []
        for index in range(len(pdf)):
            pages.append(pdf[index].get_textpage().get_text_range())
        return pages
    finally:
        pdf.close()


def extract_references(text: str) -> tuple[str, str]:
    """Return (references_text, how). `how` records which boundary rule fired, for diagnostics."""
    matches = list(HEADING_RE.finditer(text))
    if not matches:
        return "", "no_reference_heading"
    start = matches[-1].end()
    tail = text[start:]
    end = END_RE.search(tail)
    if end:
        return tail[: end.start()].strip(), "heading_to_appendix"
    return tail.strip(), "heading_to_end"


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract a paper's reference block")
    parser.add_argument("pdf")
    parser.add_argument(
        "--max-chars",
        type=int,
        default=120_000,
        help="truncate the reference block; 0 disables the cap",
    )
    args = parser.parse_args()

    pages = page_texts(args.pdf)
    references, how = extract_references("\n".join(pages))
    truncated = False
    if args.max_chars and len(references) > args.max_chars:
        references = references[: args.max_chars]
        truncated = True

    json.dump(
        {
            "ok": bool(references),
            "reason": None if references else how,
            "how": how,
            "pages": len(pages),
            "references": references,
            "truncated": truncated,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
