"""Turn filtered OpenReview acceptance notifications into local tweet drafts."""

import random
import re

from .acceptance import classify_acceptance
from .messages import clean, extract_links, one_line, paper_title, unquoted_body


MENTIONS = (
    "@MPI_IS @ELLISforEurope @UofTCompSci @VectorInst @TorontoSRI "
    "@CIFAR_News @JinesisLab @EuroSafeAI @ELLISInst_Tue"
)


# Short openings with optional closings; the paper list and mentions stay fixed.
TEMPLATES = {
    1: (
        '🎉 Big congrats to our team on these acceptances at {venue}!',
        'Thanks to all our collaborators!',
    ),
    2: (
        'Good news from {venue}! New work from our team:',
        'So happy for everyone involved 😊',
    ),
    3: (
        'Our latest acceptances at {venue} 👇',
        'Kudos to the coauthors!',
    ),
    4: (
        "Really happy to share our team's work accepted at {venue}:",
        'A big thank you to our collaborators!',
    ),
    5: (
        '📣 New work accepted at {venue}! Congrats to the team:',
        '',
    ),
    6: (
        "Some research news: our team's work was accepted at {venue} 🎉",
        'Thanks to everyone who worked on this!',
    ),
    7: (
        "Here's what we've been working on, now accepted at {venue}:",
        'Would love to hear what you think.',
    ),
    8: (
        "Celebrating our team's acceptances at {venue} 🥳",
        'So glad we got to work on this together.',
    ),
    9: (
        'New reading from our team, accepted at {venue} 📚',
        'Happy to share this work with you!',
    ),
    10: (
        'Accepted at {venue}! A big congrats to our coauthors 🎉',
        '',
    ),
}


def venue_details(record):
    """Keep year and track boundaries explicit; never promote a workshop paper."""
    domain = record.get("domain", "")
    if not isinstance(domain, str):
        raise ValueError("domain must be a string")
    parts = domain.strip().strip("/").split("/")
    year_index = next((i for i, part in enumerate(parts) if re.fullmatch(r"\d{4}", part)), None)
    if year_index is None or year_index == 0:
        raise ValueError("Cannot identify venue/year from domain")
    conference = parts[year_index - 1].split(".")[0]
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", conference):
        raise ValueError("Cannot identify conference name from domain")
    conference = {"neurips": "NeurIPS", "clear": "CLeaR"}.get(conference.lower(), conference.upper())
    tag = f"#{conference.replace('-', '')}{parts[year_index]}"
    track = parts[year_index + 1:]
    if not track or [s.lower() for s in track] == ["conference"]:
        body = clean(unquoted_body(record["content"].get("text", "")))
        body = "\n\n".join(one_line(block) for block in re.split(r"\n\s*\n", body))
        findings = (
            r"\byour (?:submission|paper|manuscript)\b[^\n]{0,1000}?"
            r"\b(?:has been|was|is) accepted as (?:a )?Findings paper\b"
            r"|^\s*decision\s*:\s*accept[^\n]*\bFindings\b"
        )
        if re.search(findings, body, re.I | re.M):
            return tag, "Findings"
        return tag, "Main conference"
    if track[0].lower() == "workshop":
        name = " / ".join(part.replace("_", " ") for part in track[1:])
        return tag, f"{name} workshop".strip()
    return tag, " / ".join(part.replace("_", " ") for part in track)


def paper_url(record):
    """Use only an unambiguous forum ID from the current message."""
    _, forum_ids, _ = extract_links(unquoted_body(record["content"].get("text", "")))
    if len(forum_ids) == 1 and re.fullmatch(r"[A-Za-z0-9_-]+", forum_ids[0]):
        return f"https://openreview.net/forum?id={forum_ids[0]}"
    return None


def same_paper(paper, title, url):
    if paper["url"] and url:
        return paper["url"] == url
    return paper["title"].casefold() == title.casefold()


def group_papers(records):
    """Group identifiable papers; report reminders that lack paper metadata."""
    groups, skipped = {}, []
    for index, record in enumerate(records, 1):
        if not isinstance(record, dict) or not classify_acceptance(record).accepted:
            raise ValueError(f"Record {index}: expected an explicit paper acceptance")
        try:
            venue = venue_details(record)
            title = paper_title(record)
        except ValueError as exc:
            skipped.append(f"Record {index} ({record.get('id', 'no id')}): {exc}")
            continue
        url = paper_url(record)
        papers = groups.setdefault(venue, [])
        # A different known forum ID identifies a different paper, even when
        # titles match. Fall back to titles only when a link is missing.
        existing = next((p for p in papers if same_paper(p, title, url)), None)
        if existing is None:
            papers.append({"title": title, "url": url, "notification_ids": [record.get("id")]})
        else:
            if record.get("id") not in existing["notification_ids"]:
                existing["notification_ids"].append(record.get("id"))
            existing["url"] = existing["url"] or url
    return groups, skipped


def format_notifications(records, template=None, rng=None):
    """Return one complete announcement per conference/year, plus warnings."""
    if template is not None and template not in TEMPLATES:
        raise ValueError(f"template must be one of: {', '.join(map(str, TEMPLATES))}")
    if not isinstance(records, list):
        raise ValueError("Input must be a JSON array of filtered acceptance notifications")
    groups, skipped = group_papers(records)
    conferences = {}
    for (conference, track), papers in groups.items():
        conferences.setdefault(conference, []).extend({**paper, "track": track} for paper in papers)

    rng = rng or random.SystemRandom()
    chosen = template if template is not None else rng.choice(list(TEMPLATES))
    opening, closing = TEMPLATES[chosen]
    announcements = []
    for venue, papers in conferences.items():
        # Put the main conference first, then other tracks, then workshops.
        papers.sort(key=lambda paper: (
            paper["track"].lower().endswith("workshop"), paper["track"] != "Main conference",
        ))
        includes_workshops = any(paper["track"].lower().endswith("workshop") for paper in papers)
        display_venue = f"{venue} and its workshops" if includes_workshops else venue
        count = len(papers)
        introduction = opening.format(venue=display_venue)
        lines = [f"{i}. {paper['title']} ({paper['track']})"
                 for i, paper in enumerate(papers, 1)]
        text = "\n\n".join(part for part in [introduction, "\n".join(lines), closing, MENTIONS] if part)
        announcements.append({
            "venue": venue, "template": chosen, "paper_count": count,
            "text": text, "papers": papers,
        })
    return announcements, skipped
