#!/usr/bin/env python3
"""Extract the full text of a CV PDF.

Deliberately dumb: it returns every page's text and makes no attempt to find sections. A CV has
no common structure -- some are tables, some are prose, some are two columns -- so deciding what
counts as a position or a degree is a language judgement the local model makes downstream against
a JSON schema, exactly as adminbot-pdf-references.py stops at text and lets the model split
entries.

pypdfium2 ships PDFium as a self-contained wheel, so this works on Aurora without root.
"""

import argparse
import json
import sys

import pypdfium2

# A CV that extracts to more than this is either not a CV or is carrying an appended thesis. The
# text is about to become model input, so the cap bounds the prompt rather than trusting the file.
MAX_CHARS = 200_000


def page_texts(path: str) -> list[str]:
    try:
        pdf = pypdfium2.PdfDocument(path)
    except Exception as error:  # PdfiumError for corrupt/encrypted input
        raise SystemExit(json.dumps({"ok": False, "reason": "unreadable_pdf", "error": str(error)}))
    try:
        return [pdf[index].get_textpage().get_text_range() for index in range(len(pdf))]
    finally:
        pdf.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract CV text from a PDF.")
    parser.add_argument("pdf", help="path to the CV PDF")
    args = parser.parse_args()

    pages = page_texts(args.pdf)
    text = "\n\n".join(pages).strip()
    if not text:
        # A CV that is a scan of paper extracts to nothing. Reporting it as its own reason keeps
        # the caller from treating "no career facts" and "no readable text" as the same outcome.
        print(json.dumps({"ok": False, "reason": "no_text_layer", "pages": len(pages)}))
        return

    truncated = len(text) > MAX_CHARS
    print(
        json.dumps(
            {
                "ok": True,
                "pages": len(pages),
                "truncated": truncated,
                "text": text[:MAX_CHARS],
            }
        )
    )


if __name__ == "__main__":
    sys.exit(main())
