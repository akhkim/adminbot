"""Attach saved arXiv links without guessing paper identities or URLs."""
import re
from urllib.parse import parse_qs, urlparse


def forum_id(value):
    url = urlparse(value or "")
    if url.hostname == "openreview.net" and url.path in ("/forum", "/pdf"):
        return parse_qs(url.query).get("id", [None])[0]
    return None


def arxiv_url(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(
        r"https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/"
        r"(\d{4}\.\d{4,5}(?:v\d+)?|[a-zA-Z-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)(?:\.pdf)?/?",
        value.strip(),
    )
    return "https://arxiv.org/abs/" + match[1] if match else None


def add_arxiv_links(announcements, saved_papers):
    warnings = []
    for announcement in announcements:
        lines = announcement["text"].splitlines()
        for number, paper in enumerate(announcement["papers"], 1):
            key = forum_id(paper.get("url"))
            matches = [p for p in saved_papers if key and forum_id(p.get("submission_url")) == key]
            if not matches:
                matches = [p for p in saved_papers
                           if p["title"].strip().casefold() == paper["title"].strip().casefold()
                           and not (key and forum_id(p.get("submission_url")))]
            link = arxiv_url(matches[0].get("arxiv_url")) if len(matches) == 1 else None
            if not link:
                warnings.append(f"{paper['title']}: no unambiguous saved arXiv link; no link added.")
                continue
            paper["arxiv_url"] = link
            target = f"{number}. {paper['title']} ({paper['track']})"
            lines = [line + " " + link if line == target else line for line in lines]
        announcement["text"] = "\n".join(lines)
    return warnings
