"""Evidence for a separate abstract prerequisite; silence never means absent."""
import re

ABSTRACT_FIELDS = ("abstract_requirement", "abstract_requirement_evidence",
                   "abstract_requirement_source_url", "abstract_requirement_conflict", "abstract_deadline_id")


def requirement_from_text(text, source_url, year):
    text = re.sub(r"\[OLD\].*?\[/OLD\]", "", text, flags=re.S)
    years = set(re.findall(r"\b20\d{2}\b", text))
    if years and str(year) not in years:
        return {}
    negative = re.compile(r"(?i)\b(?:no\s+(?:separate\s+)?abstract\s+(?:registration|submission)\s+(?:is\s+)?(?:required|necessary)|(?:separate\s+)?abstract\s+(?:registration|submission)\s+(?:is\s+)?(?:not\s+required|optional))\b")
    positive = re.compile(r"(?i)\b(?:abstract\s+registration\s+(?:is\s+)?(?:required|mandatory)|authors?\s+must\s+register\s+(?:an?\s+)?abstract\b|abstract\s+registration\s+deadline\s*[:—-]?\s*(?:TBA|TBD|to\s+be\s+announced))")
    observations = []
    for sentence in re.split(r"[.\n]", text):
        sentence = re.sub(r"\s+", " ", sentence).strip()
        if not sentence or "?" in sentence:
            continue
        sentence_years = set(re.findall(r"\b20\d{2}\b", sentence))
        if sentence_years and sentence_years != {str(year)}:
            continue
        # Conditional and track-specific statements cannot establish a page-wide requirement.
        if re.search(r"(?i)\b(?:if|unless|except|track|optional papers)\b", sentence):
            continue
        if negative.search(sentence):
            observations.append(dict(abstract_requirement="not_required", abstract_requirement_evidence=sentence[:500], abstract_requirement_source_url=source_url))
        if positive.search(negative.sub("", sentence)):
            observations.append(dict(abstract_requirement="required", abstract_requirement_evidence=sentence[:500], abstract_requirement_source_url=source_url))
    return merge_requirements(*observations)


def merge_requirements(*records):
    known = [record for record in records if record.get("abstract_requirement") in {"required", "not_required"}]
    conflict = any(record.get("abstract_requirement_conflict") for record in records) or len({record["abstract_requirement"] for record in known}) > 1
    if conflict:
        return dict(abstract_requirement="unknown", abstract_requirement_conflict=True,
                    abstract_requirement_evidence="Sources disagree about abstract registration.", abstract_requirement_source_url="")
    return {key: known[-1][key] for key in ABSTRACT_FIELDS if key in known[-1]} if known else {}


def is_abstract(item):
    return item.get("milestone") == "abstract" or bool(re.search(r"(?i)\babstract\b", item.get("deadline_label", "")))


def route_key(item):
    # Venue ids can span years. Shared workshop homepages do not identify the same track.
    return tuple(item.get(key, "") for key in ("venue_id", "venue_group", "track", "submission_type"))


def attach_abstract_requirements(items):
    abstracts = {}
    for item in items:
        if is_abstract(item) and not item.get("stale") and item.get("venue_id"):
            abstracts.setdefault(route_key(item), []).append(item)
    for item in items:
        item.pop("abstract_deadline_id", None)
        if is_abstract(item) or item.get("submission_type") == "commitment":
            continue
        if item.get("milestone") not in {"full_paper", "direct_submission", "demo", "", None}:
            continue
        matches = abstracts.get(route_key(item), []) if item.get("venue_id") else []
        if len(matches) != 1:
            continue
        abstract = matches[0]
        # A later abstract deadline cannot be an earlier registration prerequisite.
        if abstract.get("deadline_aoe", "") > item.get("deadline_aoe", ""):
            continue
        # A published date does not establish whether registration is mandatory.
        item["abstract_deadline_id"] = abstract.get("deadline_id") or abstract["id"]
