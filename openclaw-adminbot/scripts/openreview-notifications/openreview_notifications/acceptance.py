"""Recognize final paper acceptances from explicit message evidence.

Rules are case-insensitive. Accept only positive evidence with no rejection or
qualification. Hypothetical instructions contribute no evidence.
"""
import re
from dataclasses import dataclass

from .messages import clean, one_line, paper_title, subject_header, unquoted_body


def pattern(expression):
    """Allow rules to be laid out and commented like ordinary code."""
    return re.compile(expression, re.IGNORECASE | re.MULTILINE | re.VERBOSE)


# Shared grammar: "your paper" or "your ICML 2026 submission".
PAPER = r"\byour\s+(?:[A-Za-z][\w.-]*\s+\d{4}\s+)?(?:paper|submission|manuscript|work)\b"
PAPER_NOUN = r"(?:papers?|submissions?|manuscripts?|work)"
# Do not cross a sentence or another reference to the recipient's paper.
DETAIL = r"(?:(?!" + PAPER + r"|[.!?]\s)[^\n]){0,1000}?"

PROPOSAL_METADATA = pattern(r"workshop[_ /-]*proposals? | /tutorials?(?:/|\s|$)")
PROPOSAL_SUBJECT = pattern(r"\b(?:workshop|tutorial)\ proposal\b")
NON_DECISION_SUBJECT = pattern(r"""
    \b(?:
        invitation\ to | accepted\ to\ review | reviewer\ invitation
        | official\ review | meta[- ]?review | comment(?:ed)?
        | received\ (?:your|a\ new\ revision) | paper.*restored | desk[- ]rejected
    )\b
""")

# Labeled decisions: "Decision: Accept", "Final Decision: Reject", etc.
DECISION_LINE = pattern(r"^\s*(?:(?:final\s+)?decision\s*:\s*)+(?P<value>[^\n]+)")
ACCEPT_VALUE = pattern(r"accept(?:ed)?\b")
REJECT_VALUE = pattern(r"(?:reject(?:ed)?|not\ accept(?:ed)?|declin(?:e|ed))\b")
UNCERTAIN_VALUE = pattern(r"""
    \b(?:conditional|conditionally|pending|provisional|provisionally|recommend|recommended|if)\b
""")
CONDITIONAL_COMMENT = pattern(r"""
    ^\s*comment\s*:[^\n]*\b(?:
        conditional\ acceptance | conditionally\ accepted
        | acceptance\ (?:is\ )?(?:conditional|pending|subject\ to)
        | accept(?:ed)?\ subject\ to
    )\b[^\n]*
""")

# Positive prose. Keep each form separate so new wording is easy to review.
DIRECT_ACCEPTANCE = pattern(PAPER + DETAIL + r"\b(?:has\ been|have\ been|was|is)\s+accepted\b")
ACTIVE_ACCEPTANCE = pattern(r"""
    \bwe\s+
    (?:are\s+(?:pleased|delighted|happy)\s+to | have\s+decided\s+to)
    \s+accept\s+your\s+(?:paper|submission|manuscript|work)\b
""")
CONGRATULATIONS = pattern(rf"""
    \bcongratulations\s+(?:(?:once\s+)?again\s+)?(?:on|for)\s+
    (?:
        the\s+acceptance\s+of\s+your\s+{PAPER_NOUN}
        | (?:having|getting)\s+your\s+{PAPER_NOUN}\s+accepted
        | your\s+accepted\s+(?:[A-Za-z][\w.-]*\s+\d{{4}}\s+)?{PAPER_NOUN}
        | your\s+{PAPER_NOUN}(?:['’]s\s+acceptance|\s+being\s+accepted|\s+acceptance)
    )\b
""")

# Negative prose. These veto otherwise positive evidence in the same message.
DIRECT_REJECTION = pattern(PAPER + DETAIL + r"""
    \b(?:
        has\ not\ been\ accepted | was\ not\ accepted | is\ not\ accepted
        | was\ not\ selected\ for\ (?:acceptance|inclusion)
        | has\ been\ rejected | was\ rejected | is\ rejected
    )\b
""")
CANNOT_ACCEPT = pattern(r"""
    \b(?:unable\ to|cannot|can\ not|could\ not)
    \s+accept\s+your\s+(?:paper|submission|manuscript)\b
""")
PROSE_RULES = (
    (DIRECT_ACCEPTANCE, "accepted", "explicit_paper_acceptance"),
    (ACTIVE_ACCEPTANCE, "accepted", "explicit_paper_acceptance"),
    (CONGRATULATIONS, "accepted", "explicit_paper_acceptance"),
    (DIRECT_REJECTION, "rejected", "explicit_paper_rejection"),
    (CANNOT_ACCEPT, "rejected", "explicit_paper_rejection"),
)

HYPOTHETICAL_BEFORE = pattern(r"\b(?:if|whether|unless|assuming|provided|once|when|recommend|hope)\b")
HYPOTHETICAL_AFTER = pattern(r"\b(?:if|provided|assuming|unless)\b")
QUALIFIED = pattern(r"\b(?:pending|conditionally|conditional|provisionally|subject\ to)\b")
NOT_FINAL = pattern(r"\b(?:for\ review|for\ consideration|revoked|rescinded|withdrawn)\b")


@dataclass(frozen=True)
class AcceptanceDecision:
    status: str
    rule: str
    evidence: str = ""

    @property
    def accepted(self):
        return self.status == "accepted"


def labeled_evidence(body):
    qualification = CONDITIONAL_COMMENT.search(body)
    if qualification:
        yield AcceptanceDecision("unknown", "conditional_decision_comment", qualification.group().strip())

    for match in DECISION_LINE.finditer(body):
        value = match.group("value").strip()
        evidence = match.group().strip()
        if UNCERTAIN_VALUE.search(value):
            yield AcceptanceDecision("unknown", "conditional_or_recommended_decision", evidence)
        elif ACCEPT_VALUE.match(value):
            yield AcceptanceDecision("accepted", "explicit_decision_accept", evidence)
        elif REJECT_VALUE.match(value):
            yield AcceptanceDecision("rejected", "explicit_decision_reject", evidence)


def prose_context(paragraph, match):
    """Return final, uncertain, or hypothetical for a candidate prose match."""
    prefix = re.split(r"[.!?]", paragraph[:match.start()])[-1]
    # "Once again, congratulations" is not a hypothetical condition.
    prefix = re.sub(r"\bonce again\b", "", prefix, flags=re.I)
    tail = paragraph[match.end():]
    following = re.split(r"[.!?]", tail)[0][:200]

    if QUALIFIED.search(match.group() + following) or NOT_FINAL.search(following):
        return "uncertain"
    if tail.lstrip().startswith("?"):
        return "uncertain"
    if HYPOTHETICAL_BEFORE.search(prefix) or HYPOTHETICAL_AFTER.search(following):
        return "hypothetical"
    return "final"


def prose_evidence(body, title):
    title_pattern = None
    if title:
        title_pattern = re.compile("(" + PAPER + r"[^.!?\n]{0,150}?)" + re.escape(title), re.I)

    for block in re.split(r"\n\s*\n", body):
        paragraph = one_line(block)
        if title_pattern:
            paragraph = title_pattern.sub(r"\1[paper title]", paragraph)
        for expression, status, rule in PROSE_RULES:
            for match in expression.finditer(paragraph):
                context = prose_context(paragraph, match)
                if context == "uncertain":
                    yield AcceptanceDecision("unknown", "conditional_statement", paragraph[:500])
                elif context == "final":
                    yield AcceptanceDecision(status, rule, match.group()[:500])


def resolve_evidence(evidence):
    positive = next((item for item in evidence if item.accepted), None)
    negative = next((item for item in evidence if item.status == "rejected"), None)
    uncertain = next((item for item in evidence if item.status == "unknown"), None)
    if positive and negative:
        return AcceptanceDecision(
            "unknown", "conflicting_decision_evidence", positive.evidence + " | " + negative.evidence,
        )
    if uncertain:
        return uncertain
    if negative:
        return negative
    if positive:
        return positive
    return AcceptanceDecision(
        "unknown", "no_explicit_acceptance", "No explicit paper acceptance is stated in the message.",
    )


def classify_acceptance(record):
    """Validate the message, exclude non-decisions, then evaluate its evidence."""
    content = record.get("content") if isinstance(record, dict) else None
    if not isinstance(content, dict):
        return AcceptanceDecision("unknown", "missing_message")
    subject, text = content.get("subject", ""), content.get("text", "")
    if not isinstance(subject, str) or not isinstance(text, str):
        return AcceptanceDecision("unknown", "missing_message")

    header = subject_header(clean(subject))
    metadata = " ".join(str(record.get(key, "")) for key in ("domain", "invitation"))
    if PROPOSAL_METADATA.search(metadata) or PROPOSAL_SUBJECT.search(header):
        return AcceptanceDecision("not_acceptance", "non_paper_proposal", header)
    event = NON_DECISION_SUBJECT.search(header)
    if event:
        return AcceptanceDecision("not_acceptance", "non_acceptance_event", event.group())

    body = clean(unquoted_body(text))
    try:
        title = one_line(clean(paper_title(record)))
    except ValueError:
        title = None
    evidence = list(labeled_evidence(body)) + list(prose_evidence(body, title))
    return resolve_evidence(evidence)
