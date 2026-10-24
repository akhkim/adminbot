"""Recover missing links from other notifications for the exact venue and submission."""
import re

from openreview_notifications.messages import extract_links, unquoted_body


def submission_key(record):
    if not isinstance(record, dict):
        return None
    domain = record.get("domain")
    content = record.get("content")
    if not isinstance(domain, str) or not re.search(r"/\d{4}/[^/]+", domain):
        return None
    if not isinstance(content, dict) or not isinstance(content.get("subject"), str):
        return None
    numbers = set(re.findall(
        r"\b(?:submission\s*#?\s*|paper\s+number\s*:\s*)(\d+)\b",
        content["subject"], re.I,
    ))
    if len(numbers) != 1:
        return None
    return domain.strip().strip("/"), int(next(iter(numbers)))


def recover_paper_links(announcements, selected, records):
    # Search the full export: reviewer notifications may predate the acceptance cutoff.
    candidates = {}
    for record in records:
        key = submission_key(record)
        if key is None:
            continue
        text = record["content"].get("text", "")
        if not isinstance(text, str):
            continue
        ids = extract_links(unquoted_body(text))[1]
        candidates.setdefault(key, set()).update(
            value for value in ids if re.fullmatch(r"[A-Za-z0-9_-]+", value)
        )
    selected_keys = {}
    for record in selected:
        key = submission_key(record)
        if key is not None and isinstance(record.get("id"), str):
            selected_keys.setdefault(record["id"], set()).add(key)
    warnings = []
    for announcement in announcements:
        for paper in announcement["papers"]:
            if paper.get("url"):
                continue
            keys = set().union(*(selected_keys.get(value, set()) for value in paper["notification_ids"]))
            ids = set().union(*(candidates.get(key, set()) for key in keys))
            if len(ids) == 1:
                paper["url"] = "https://openreview.net/forum?id=" + next(iter(ids))
            elif len(ids) > 1:
                warnings.append(f"{paper['title']}: conflicting OpenReview links for this venue/submission; no link chosen.")
    return warnings
