"""
Shared pieces of the Opportunities sweeps: how a page is fetched, and which phrases mark a date an
applicant is bound by.

A module rather than an import from the sweep scripts because their filenames carry dashes and are
not importable -- the same reason `adminbot_deadlines.py` exists beside its collectors.
"""
import urllib.request

import re

# The same agent string the deadline collector introduces itself with. A sweep that reads a
# university's page should say who it is; several of these hosts block a bare urllib default.
HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36 AdminBot/1.0 (+https://admin.safe.eu)"
    ),
    "Accept-Language": "en",
}

# The phrases that mark a date an applicant is bound by.
#
# Passed in rather than added to the shared list: that one is tuned for papers ("submission
# deadline", "papers are due") across 143 workshops, and finds nothing at all on a fellowship page
# -- verified, it returns zero candidates. Adding application words there would let a CFP page that
# mentions an application deadline outrank its own paper deadline.
OPPORTUNITY_SIGNALS = (
    (re.compile(r"(?i)\bapplication\s+deadline\b"), 260),
    # Real pages say this at least as often as "application deadline" -- NSF GRFP heads its table
    # with it, and against the first vocabulary this sweep read that page and found nothing.
    (re.compile(r"(?i)\bapplicant\s+deadlines?\b"), 255),
    (re.compile(r"(?i)\bapplications?\s+(?:are\s+)?(?:now\s+)?due\b"), 250),
    (re.compile(r"(?i)\bdeadline\s+to\s+apply\b"), 245),
    (re.compile(r"(?i)\bnomination\s+deadline\b"), 240),
    (re.compile(r"(?i)\bapplications?\s+close[sd]?\b"), 235),
    (re.compile(r"(?i)\bapply\s+by\b"), 220),
    (re.compile(r"(?i)\bclosing\s+date\b"), 210),
)

# Rows that are dated on the same page but are not the applicant's own deadline. NSF GRFP heads
# its table with "Applicant deadlines" and then lists the reference-letter date first, so without
# this the highest-scoring candidate on that page is a date the applicant is not bound by.
NOT_THE_APPLICANTS_DATE = re.compile(
    r"(?i)reference\s+letters?|notification|results?\s+(?:are\s+)?announced|awards?\s+announced"
)



def fetch_html(url, timeout=20):
    """The page, and the URL it actually resolved to after redirects."""
    request = urllib.request.Request(
        url,
        headers={**HTTP_HEADERS, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(2_000_000)
        charset = response.headers.get_content_charset() or "utf-8"
        return response.geturl(), body.decode(charset, errors="replace")
