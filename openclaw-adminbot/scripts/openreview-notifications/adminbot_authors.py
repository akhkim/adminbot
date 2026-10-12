"""Read OpenReview authors and match against a local, service-supplied roster."""
import os
import re
from urllib.parse import parse_qs, urlparse


def identity(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith("https://openreview.net/profile?"):
        value = parse_qs(urlparse(value).query).get("id", [""])[0]
    if value.startswith("~"):
        return value
    if re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        return value.lower()
    return None


def field(content, name):
    value = (content or {}).get(name)
    return value.get("value") if isinstance(value, dict) else value


def author_ids(content):
    # Some venues return structured authors instead of an authorids field.
    values = field(content, "authorids") or []
    authors = field(content, "authors") or []
    values = values if isinstance(values, list) else []
    authors = authors if isinstance(authors, list) else []
    values = values + [a.get("username") for a in authors if isinstance(a, dict)]
    return list(dict.fromkeys(key for value in values if (key := identity(value))))


def connect():
    username, password = os.getenv("OPENREVIEW_USERNAME"), os.getenv("OPENREVIEW_PASSWORD")
    if not username or not password:
        raise ValueError("Set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD in the AdminBot service environment to match authors.")
    try:
        from openreview.api import OpenReviewClient
    except ImportError:
        raise ValueError("Install scripts/openreview-notifications/requirements.txt in ADMINBOT_NOTIFICATIONS_PYTHON's environment.") from None
    try:
        client = OpenReviewClient(baseurl="https://api2.openreview.net", username=username, password=password)
        if not client.profile:
            raise ValueError("No profile")
        return client
    except Exception:
        # SDK errors can contain private response details.
        raise ValueError("OpenReview sign-in failed. Check the service's OpenReview credentials and account access.") from None


def enrich(announcements, members, client_factory=connect):
    roster = {}
    for member in members:
        key = identity(member.get("openreview_id"))
        if key:
            roster.setdefault(key, []).append(member.get("handle"))
    warnings, cache = [], {}
    client = None
    for announcement in announcements:
        handles = {}
        for paper in announcement["papers"]:
            paper["author_handles"] = []
            paper["author_ids"] = []
            url = urlparse(paper.get("url") or "")
            paper_id = parse_qs(url.query).get("id", [""])[0]
            if url.hostname != "openreview.net" or not re.fullmatch(r"[A-Za-z0-9_-]+", paper_id):
                warnings.append(f"{paper['title']}: no unambiguous OpenReview paper link; authors not matched.")
                continue
            if client is None:
                client = client_factory()
            if paper_id not in cache:
                try:
                    cache[paper_id] = author_ids(client.get_note(paper_id).content)
                except Exception:
                    cache[paper_id] = None
            ids = cache[paper_id]
            if not ids:
                warnings.append(f"{paper['title']}: author IDs could not be retrieved or are not visible to this account.")
                continue
            paper["author_ids"] = ids
            for key in ids:
                matches = roster.get(key, [])
                if len(matches) != 1:
                    reason = "multiple member records" if matches else "no matching member"
                    warnings.append(f"{paper['title']}: {key} has {reason}; no X mention added.")
                    continue
                handle = matches[0]
                if not isinstance(handle, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
                    warnings.append(f"{paper['title']}: {key} has no valid saved X handle.")
                    continue
                mention = "@" + handle
                paper["author_handles"].append(mention)
                handles.setdefault(handle.lower(), mention)
        if handles:
            announcement["text"] += "\n\nAuthors: " + " ".join(handles.values())
    return warnings
