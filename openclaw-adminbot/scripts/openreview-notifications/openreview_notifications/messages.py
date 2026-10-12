"""Read text and titles from notification messages without interpreting outcomes."""
import html
import re
from urllib.parse import parse_qs, urlsplit


def clean(text):
    return re.sub(r"[*_`]+", "", text).replace("\\!", "!").replace("\r\n", "\n")


def unquoted_body(text):
    """Ignore quoted replies and forwarded messages when reading decisions."""
    text = re.split(
        r"(?im)^\s*(?:-+\s*(?:Original Message|Forwarded message)\s*-+|"
        r"Begin forwarded message:|On .+ wrote:)\s*$", text,
    )[0]
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(">"))


def one_line(value):
    return re.sub(r"\s+", " ", value).strip()


def paper_title(record):
    """Read common decision titles without inventing one for generic reminders."""
    content = record["content"]
    subject = content.get("subject", "")
    body = unquoted_body(content.get("text", ""))
    patterns = [
        (subject, r"\bsubmission\s+#?\d+\s*:\s*(.+)$"),
        (subject, r"\bAcceptance Notification for\s+(.+)$"),
        (subject, r'\btitled\s+["“](.+)["”](?:\s+is now available)?\s*$'),
        (one_line(body),
         r'\byour\s+(?:submission|paper|manuscript)\s*,?\s*'
         r'(?:\*\*)?["“](.+?)["”](?:\*\*)?'
         r'(?=\s*(?:[,.(]|to\b|has been\b|was\b|is\b))'),
        (body, r"^\s*(?:paper\s+)?title\s*:\s*(.+)$"),
        (one_line(body),
         r"\byour (?:submission|paper) to [^,]+,\s*(.+?),\s*"
         r"(?:has (?:not )?been|was|is) (?:not )?accepted\b"),
    ]
    for text, pattern in patterns:
        match = re.search(pattern, text, re.I | re.M)
        if match:
            title = one_line(match.group(1))
            if not title or "{{" in title:
                raise ValueError("Paper title is empty or contains an unfilled template placeholder")
            return title
    raise ValueError("Cannot extract paper title from this notification")



def subject_header(subject):
    """Keep notification type and venue text; omit paper titles."""
    return re.split(
        r"\b(?:paper title|titled|acceptance notification for)\b|\bsubmission\s+#?\d+\b",
        subject, maxsplit=1, flags=re.I,
    )[0]


def extract_links(text):
    """Extract literal OpenReview URLs, not inferred paper titles or IDs."""
    urls, forums, notes = [], [], []
    # Decode only terminated entities: generic html.unescape corrupts a literal
    # '&noteId=' query parameter by interpreting its '&not' prefix as an entity.
    decoded = re.sub(r"&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);",
                     lambda match: html.unescape(match.group()), text)
    for match in re.finditer(r'https?://[^\s<>"\x27]+', decoded, re.I):
        url = match.group().rstrip(".,;:!?)]}")
        try:
            parts = urlsplit(url)
            if parts.hostname not in {"openreview.net", "www.openreview.net"}:
                continue
            if parts.username or parts.password:
                continue
        except ValueError:
            continue
        if url not in urls:
            urls.append(url)
        query = parse_qs(parts.query)
        forum = query.get("forum", [])
        note = query.get("noteId", [])
        if parts.path.rstrip("/") == "/forum":
            forum += query.get("id", [])
        elif parts.path.rstrip("/") == "/pdf":
            note += query.get("id", [])
        for value in forum:
            if value not in forums:
                forums.append(value)
        for value in note:
            if value not in notes:
                notes.append(value)
    return urls, forums, notes
