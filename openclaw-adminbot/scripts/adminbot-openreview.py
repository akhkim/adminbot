#!/usr/bin/env python3
"""
AdminBot OpenReview bridge. Every OpenReview API call the reviewing-cycle
automation makes goes through this script; the TypeScript side owns state,
cadence, and policy and never speaks HTTP to OpenReview itself.

Contract: one subcommand per invocation, a single JSON object on stdout, exit 0
whenever that JSON was produced (including expected failures, which come back as
{"ok": false, "reason": ...} so the caller can record a status instead of
treating it as a crash). Exit 1 only for a genuine crash, with the traceback on
stderr.

Subcommands
  discover                 venues this profile serves in, with the review deadline
  status --venue --role    who still owes a review (the whole point)
  message ... [--send]     post_message through the venue's own message invitation
  load-form --venue        the open reviewing-load/registration form, prefilled
  assign --venue ...       add/remove a reviewer assignment edge (never automatic)

Nothing about a venue is hardcoded: role group ids, anon-group naming, the
review invitation name, assignment invitations, and the per-submission message
invitation templates are all read from the venue group's content at runtime,
because they are venue- and year-specific.

Env:
  OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD   absent -> {"ok": false, "reason": "no_credentials"}
  OPENREVIEW_BASEURL                          default https://api2.openreview.net
"""
import argparse
import json
import os
import re
import sys
import traceback

BASEURL = os.environ.get("OPENREVIEW_BASEURL", "https://api2.openreview.net")
# A venue whose review deadline is this far in the past is a finished cycle, not a
# late one; discovery drops it so old conferences don't accumulate forever.
STALE_AFTER_DAYS = 60
ROLE_KEYS = {
    "reviewer": ("reviewers_id", "reviewers_assignment_id", "reviewers_anon_name"),
    "ac": ("area_chairs_id", "area_chairs_assignment_id", "area_chairs_anon_name"),
    "sac": ("senior_area_chairs_id", "senior_area_chairs_assignment_id", None),
}


def out(payload):
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


def fail(reason, message=None, **extra):
    out({"ok": False, "reason": reason, "error": message or reason, **extra})
    sys.exit(0)


def connect():
    user = os.environ.get("OPENREVIEW_USERNAME")
    password = os.environ.get("OPENREVIEW_PASSWORD")
    if not (user and password):
        fail("no_credentials", "OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD are not set")
    try:
        import openreview  # noqa: F401
        from openreview.api import OpenReviewClient
    except ImportError as exc:
        fail("missing_dependency", f"openreview-py is not importable: {exc}")
    try:
        client = OpenReviewClient(baseurl=BASEURL, username=user, password=password)
    except Exception as exc:
        fail("auth_failed", str(exc))
    if not getattr(client, "profile", None):
        fail("auth_failed", "login succeeded but no profile was returned")
    return client


# --------------------------------------------------------------------------
# venue context: everything venue-shaped, resolved from the venue group content
# --------------------------------------------------------------------------
def value_of(content, key, default=None):
    entry = (content or {}).get(key)
    if isinstance(entry, dict):
        return entry.get("value", default)
    return default if entry is None else entry


def venue_context(client, venue_id):
    try:
        group = client.get_group(venue_id)
    except Exception as exc:
        return None, f"venue group {venue_id} is unreadable: {exc}"
    content = group.content or {}
    if not value_of(content, "reviewers_id"):
        return None, f"{venue_id} does not look like an API2 venue (no reviewers_id)"
    ctx = {
        "venue_id": venue_id,
        "title": value_of(content, "title") or venue_id,
        "submission_name": value_of(content, "submission_name") or "Submission",
        "submission_id": value_of(content, "submission_id"),
        "review_name": value_of(content, "review_name"),
        "reviewers_id": value_of(content, "reviewers_id"),
        "reviewers_name": value_of(content, "reviewers_name") or "Reviewers",
        "reviewers_anon_name": value_of(content, "reviewers_anon_name") or "Reviewer_",
        "reviewers_assignment_id": value_of(content, "reviewers_assignment_id"),
        "reviewers_custom_max_papers_id": value_of(content, "reviewers_custom_max_papers_id"),
        "reviewers_message_submission_id": value_of(content, "reviewers_message_submission_id"),
        "area_chairs_id": value_of(content, "area_chairs_id"),
        "area_chairs_name": value_of(content, "area_chairs_name") or "Area_Chairs",
        "area_chairs_anon_name": value_of(content, "area_chairs_anon_name") or "Area_Chair_",
        "area_chairs_assignment_id": value_of(content, "area_chairs_assignment_id"),
        "area_chairs_custom_max_papers_id": value_of(content, "area_chairs_custom_max_papers_id"),
        "area_chairs_message_submission_id": value_of(content, "area_chairs_message_submission_id"),
        "senior_area_chairs_id": value_of(content, "senior_area_chairs_id"),
        "senior_area_chairs_assignment_id": value_of(content, "senior_area_chairs_assignment_id"),
        # False means a SAC is assigned to ACs rather than to papers, which changes
        # what the assignment edge head points at.
        "sac_paper_assignments": bool(value_of(content, "sac_paper_assignments", False)),
    }
    # Older/oddly-configured venues omit these; derive the conventional ids so a
    # missing content key degrades to the standard layout instead of a crash.
    sub = ctx["submission_name"]
    if not ctx["reviewers_message_submission_id"]:
        ctx["reviewers_message_submission_id"] = f"{venue_id}/{sub}{{number}}/-/Message"
    if ctx["area_chairs_id"] and not ctx["area_chairs_message_submission_id"]:
        ctx["area_chairs_message_submission_id"] = (
            f"{venue_id}/{sub}{{number}}/{ctx['area_chairs_name']}/-/Message"
        )
    return ctx, None


def paper_group_prefix(ctx, number):
    return f"{ctx['venue_id']}/{ctx['submission_name']}{number}"


def review_invitation_id(ctx, number):
    return f"{paper_group_prefix(ctx, number)}/-/{ctx['review_name']}"


def message_invitation_id(ctx, role, number):
    template = (
        ctx["area_chairs_message_submission_id"]
        if role == "sac"
        else ctx["reviewers_message_submission_id"]
    )
    return template.replace("{number}", str(number))


# --------------------------------------------------------------------------
# discover
# --------------------------------------------------------------------------
def error_status(exc):
    """(status, name) out of an OpenReviewException payload, ({}, None) otherwise."""
    payload = exc.args[0] if exc.args and isinstance(exc.args[0], dict) else {}
    return payload.get("status"), payload.get("name")


def child_review_invitations(client, super_id, limit=1):
    """The per-submission invitations the venue-level one spawns. A list query
    returns only what this profile may read, so it succeeds where get_invitation
    403s. Non-expired first: that is the cycle we care about."""
    for expired in (None, True):
        params = {"invitation": super_id, "limit": limit}
        if expired is not None:
            params["expired"] = expired
        try:
            found = client.get_invitations(**params)
        except Exception:
            found = []
        if found:
            return found
    return []


def assigned_review_invitation(client, ctx, role, profile_id):
    """Last resort: the review invitation of a submission this profile is
    actually assigned to, which it can always read."""
    assignment_id = ctx.get(ROLE_KEYS[role][1])
    for note_id in submissions_for(client, ctx, assignment_id, profile_id)[:3]:
        note = load_note(client, {}, note_id)
        if not note:
            continue
        try:
            return client.get_invitation(review_invitation_id(ctx, note["number"]))
        except Exception:
            continue
    return None


def review_invitation_for(client, ctx, role, profile_id):
    """The invitation to take this cycle's dates from, as (invitation, error).

    The venue-level invitation is the canonical one, but on most real venues it
    is readable only by the organizers, so a committee member gets a 403 (or a
    400 once it expires) on exactly the venues they serve on. Fall back to the
    per-submission invitations, which the paper's committee can always read.
    Anything without a duedate is no more useful than no invitation at all, so
    the fallbacks also run when the venue-level one carries no dates.
    """
    super_id = f"{ctx['venue_id']}/-/{ctx['review_name']}"
    candidates = []
    top_error = None
    top_status = None
    try:
        candidates.append(client.get_invitation(super_id))
    except Exception as exc:
        top_status, _ = error_status(exc)
        top_error = f"review invitation unreadable: {exc}"

    def dated():
        return next((inv for inv in candidates if getattr(inv, "duedate", None)), None)

    if not dated():
        candidates.extend(child_review_invitations(client, super_id))
    if not dated():
        assigned = assigned_review_invitation(client, ctx, role, profile_id)
        if assigned:
            candidates.append(assigned)

    invitation = dated()
    if invitation:
        return invitation, None
    if candidates:
        return None, "review invitation has no duedate"
    if top_status == 404:
        return None, "review stage is not published yet"
    return None, top_error or "review invitation unreadable"


def role_of_group(group_id, venue_ids_seen):
    """Classify a top-level committee group id into (venue_id, role)."""
    for role, suffix in (
        ("sac", "/Senior_Area_Chairs"),
        ("ac", "/Area_Chairs"),
        ("reviewer", "/Reviewers"),
    ):
        if group_id.endswith(suffix):
            venue_id = group_id[: -len(suffix)]
            # Per-submission committee groups (".../Submission12/Reviewers") and
            # anon groups are not venue-level roles.
            if re.search(r"/[A-Za-z_]+\d+$", venue_id):
                return None, None
            venue_ids_seen.add(venue_id)
            return venue_id, role
    return None, None


def cmd_discover(args):
    client = connect()
    profile_id = client.profile.id
    try:
        groups = client.get_all_groups(member=profile_id)
    except Exception as exc:
        fail("group_lookup_failed", str(exc))

    seen = set()
    pairs = []
    for group in groups:
        venue_id, role = role_of_group(group.id, seen)
        if venue_id and role:
            pairs.append((venue_id, role))

    import datetime

    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    stale_before = now_ms - STALE_AFTER_DAYS * 86400000

    venues = []
    skipped = []
    contexts = {}
    for venue_id, role in sorted(set(pairs)):
        if venue_id not in contexts:
            contexts[venue_id] = venue_context(client, venue_id)
        ctx, err = contexts[venue_id]
        if err:
            skipped.append({"venue_id": venue_id, "role": role, "reason": err})
            continue
        if not ctx["review_name"]:
            skipped.append(
                {"venue_id": venue_id, "role": role, "reason": "no review stage configured yet"}
            )
            continue
        invitation, err = review_invitation_for(client, ctx, role, profile_id)
        if err:
            skipped.append({"venue_id": venue_id, "role": role, "reason": err})
            continue
        duedate = invitation.duedate
        if duedate < stale_before:
            skipped.append({"venue_id": venue_id, "role": role, "reason": "deadline is stale"})
            continue
        venues.append(
            {
                "venue_id": venue_id,
                "title": ctx["title"],
                "role": role,
                # the venue-level id, even when the dates came from a per-paper
                # child of it, because that is the cycle's stable identity
                "review_invitation_id": f"{venue_id}/-/{ctx['review_name']}",
                "deadline_ms": duedate,
                "expdate_ms": getattr(invitation, "expdate", None),
                # cdate is when reviewing opened; the halfway milestone is measured
                # from it, falling back to the deadline itself if absent.
                "cycle_start_ms": getattr(invitation, "cdate", None),
            }
        )
    out({"ok": True, "profile_id": profile_id, "venues": venues, "skipped": skipped})


# --------------------------------------------------------------------------
# status
# --------------------------------------------------------------------------
def submissions_for(client, ctx, invitation_id, tail):
    """Assignment-edge heads for `tail`, as note ids."""
    if not invitation_id:
        return []
    try:
        edges = client.get_all_edges(invitation=invitation_id, tail=tail)
    except Exception:
        return []
    return [edge.head for edge in edges]


def load_note(client, cache, note_id):
    if note_id not in cache:
        try:
            note = client.get_note(note_id)
            cache[note_id] = {
                "id": note.id,
                "number": note.number,
                "title": value_of(note.content, "title") or "",
                "abstract": value_of(note.content, "abstract") or "",
                "keywords": value_of(note.content, "keywords") or [],
            }
        except Exception:
            cache[note_id] = None
    return cache[note_id]


def paper_committee(client, ctx, number):
    """One prefix query per submission gives the reviewer roster, the anon->real
    map used to attribute reviews, and this profile's own anon signatures."""
    prefix = paper_group_prefix(ctx, number)
    try:
        groups = client.get_all_groups(prefix=f"{prefix}/")
    except Exception:
        groups = []
    reviewers = []
    anon_to_real = {}
    anon_reviewer_prefix = f"{prefix}/{ctx['reviewers_anon_name']}"
    anon_ac_prefix = f"{prefix}/{ctx['area_chairs_anon_name']}"
    area_chairs = []
    for group in groups:
        gid = group.id
        members = list(group.members or [])
        if gid == f"{prefix}/{ctx['reviewers_name']}":
            reviewers = members
        elif ctx["area_chairs_id"] and gid == f"{prefix}/{ctx['area_chairs_name']}":
            area_chairs = members
        elif gid.startswith(anon_reviewer_prefix) and members:
            anon_to_real[gid] = members[0]
        elif gid.startswith(anon_ac_prefix) and members:
            anon_to_real[gid] = members[0]
    return {
        "reviewers": reviewers,
        "area_chairs": area_chairs,
        "anon_to_real": anon_to_real,
    }


def submitted_reviewers(client, ctx, number, anon_to_real):
    try:
        notes = client.get_all_notes(invitation=review_invitation_id(ctx, number))
    except Exception:
        return set(), 0
    done = set()
    for note in notes:
        for signature in note.signatures or []:
            done.add(anon_to_real.get(signature, signature))
    return done, len(notes)


def anon_signature_for(anon_to_real, profile_id, prefix):
    for anon, real in anon_to_real.items():
        if real == profile_id and anon.startswith(prefix):
            return anon
    return None


def submission_status(client, ctx, note, profile_id):
    """Missing-review state for one submission, plus the signature this profile
    would have to sign a message with."""
    number = note["number"]
    committee = paper_committee(client, ctx, number)
    done, review_count = submitted_reviewers(client, ctx, number, committee["anon_to_real"])
    missing = [r for r in committee["reviewers"] if r not in done]
    prefix = paper_group_prefix(ctx, number)
    return {
        "note_id": note["id"],
        "number": number,
        "title": note["title"],
        "abstract": note["abstract"],
        "keywords": note["keywords"],
        "assigned_reviewers": committee["reviewers"],
        "area_chairs": committee["area_chairs"],
        "submitted_reviewers": sorted(done & set(committee["reviewers"])),
        "missing_reviewers": missing,
        "review_count": review_count,
        "reviewers_group_id": f"{prefix}/{ctx['reviewers_name']}",
        "area_chairs_group_id": f"{prefix}/{ctx['area_chairs_name']}" if ctx["area_chairs_id"] else None,
        "my_ac_signature": anon_signature_for(
            committee["anon_to_real"], profile_id, f"{prefix}/{ctx['area_chairs_anon_name']}"
        ),
        "my_reviewer_signature": anon_signature_for(
            committee["anon_to_real"], profile_id, f"{prefix}/{ctx['reviewers_anon_name']}"
        ),
        "my_sac_signature": f"{prefix}/{ctx['senior_area_chairs_id'].rsplit('/', 1)[-1]}"
        if ctx["senior_area_chairs_id"]
        else None,
    }


def cmd_status(args):
    client = connect()
    profile_id = client.profile.id
    ctx, err = venue_context(client, args.venue)
    if err:
        fail("venue_unreadable", err, venue_id=args.venue)
    if not ctx["review_name"]:
        fail("no_review_stage", "venue has no review stage configured", venue_id=args.venue)

    role = args.role
    cache = {}
    papers = []
    per_ac = {}

    if role in ("ac", "reviewer"):
        key = "area_chairs_assignment_id" if role == "ac" else "reviewers_assignment_id"
        heads = submissions_for(client, ctx, ctx[key], profile_id)
        for head in heads:
            note = load_note(client, cache, head)
            if note:
                papers.append(submission_status(client, ctx, note, profile_id))
    elif role == "sac":
        heads = submissions_for(client, ctx, ctx["senior_area_chairs_assignment_id"], profile_id)
        if ctx["sac_paper_assignments"]:
            # SAC assigned directly to papers: the AC of each paper is the target.
            note_ids = heads
        else:
            # SAC assigned to ACs: expand each AC into their papers.
            note_ids = []
            for ac_id in heads:
                note_ids.extend(
                    submissions_for(client, ctx, ctx["area_chairs_assignment_id"], ac_id)
                )
        for head in dict.fromkeys(note_ids):
            note = load_note(client, cache, head)
            if not note:
                continue
            status = submission_status(client, ctx, note, profile_id)
            papers.append(status)
            for ac_id in status["area_chairs"] or ["unassigned"]:
                bucket = per_ac.setdefault(ac_id, {"ac_id": ac_id, "papers": [], "missing": 0})
                bucket["papers"].append(status["number"])
                bucket["missing"] += len(status["missing_reviewers"])
    else:
        fail("bad_role", f"unknown role {role!r}")

    total_missing = sum(len(p["missing_reviewers"]) for p in papers)
    out(
        {
            "ok": True,
            "profile_id": profile_id,
            "venue_id": args.venue,
            "title": ctx["title"],
            "role": role,
            "papers": papers,
            "area_chairs": sorted(per_ac.values(), key=lambda b: -b["missing"]),
            "total_papers": len(papers),
            "total_missing": total_missing,
        }
    )


# --------------------------------------------------------------------------
# message
# --------------------------------------------------------------------------
def cmd_message(args):
    body = sys.stdin.read() if args.body_file == "-" else open(args.body_file).read()
    groups = [g for g in (args.groups or "").split(",") if g.strip()]
    if not groups:
        fail("no_recipients", "--groups resolved to an empty list")
    payload = {
        "invitation": args.invitation,
        "signature": args.signature,
        "recipients": groups,
        "subject": args.subject,
        "message": body,
    }
    if not args.send:
        out({"ok": True, "sent": False, "dry_run": True, "payload": payload})
        return
    client = connect()
    try:
        response = client.post_message(
            subject=args.subject,
            recipients=groups,
            message=body,
            invitation=args.invitation,
            signature=args.signature,
        )
    except Exception as exc:
        text = str(exc)
        # A venue that does not let this role message is a permanent condition for
        # that venue: report it as blocked so the caller stops retrying, rather
        # than as a transient error.
        denied = any(
            marker in text.lower()
            for marker in ("forbidden", "not have permission", "invitation not found", "notfound")
        )
        fail("message_denied" if denied else "message_failed", text, payload=payload)
    out({"ok": True, "sent": True, "payload": payload, "response": response})


# --------------------------------------------------------------------------
# load-form
# --------------------------------------------------------------------------
def registration_candidates(ctx, role):
    group_id = {
        "reviewer": ctx["reviewers_id"],
        "ac": ctx["area_chairs_id"],
        "sac": ctx["senior_area_chairs_id"],
    }.get(role)
    if not group_id:
        return []
    return [f"{group_id}/-/Registration", f"{group_id}/-/Recruitment"]


def cmd_load_form(args):
    client = connect()
    profile_id = client.profile.id
    ctx, err = venue_context(client, args.venue)
    if err:
        fail("venue_unreadable", err, venue_id=args.venue)

    forms = []
    for invitation_id in registration_candidates(ctx, args.role):
        try:
            invitation = client.get_invitation(invitation_id)
        except Exception:
            continue
        try:
            existing = client.get_all_notes(invitation=invitation_id, signatures=[profile_id])
        except Exception:
            existing = []
        forms.append(
            {
                "invitation_id": invitation_id,
                "duedate_ms": getattr(invitation, "duedate", None),
                "expdate_ms": getattr(invitation, "expdate", None),
                "fields": ((invitation.edit or {}).get("note", {}).get("content") or {}),
                "submitted": bool(existing),
                "submitted_content": existing[0].content if existing else None,
                "url": f"https://openreview.net/group?id={ctx['venue_id']}",
            }
        )

    # The reviewing *load* proper is a Custom_Max_Papers edge, separate from the
    # registration note and often the only thing that actually needs committing.
    max_papers_id = (
        ctx["area_chairs_custom_max_papers_id"]
        if args.role == "ac"
        else ctx["reviewers_custom_max_papers_id"]
    )
    custom_max_papers = None
    if max_papers_id:
        try:
            edges = client.get_all_edges(invitation=max_papers_id, tail=profile_id)
            custom_max_papers = {
                "invitation_id": max_papers_id,
                "current": edges[0].weight if edges else None,
            }
        except Exception:
            custom_max_papers = {"invitation_id": max_papers_id, "current": None}

    out(
        {
            "ok": True,
            "venue_id": args.venue,
            "title": ctx["title"],
            "role": args.role,
            "forms": forms,
            "custom_max_papers": custom_max_papers,
        }
    )


# --------------------------------------------------------------------------
# assign  (only ever reached from an explicit human click)
# --------------------------------------------------------------------------
def cmd_assign(args):
    client = connect()
    ctx, err = venue_context(client, args.venue)
    if err:
        fail("venue_unreadable", err, venue_id=args.venue)
    invitation_id = ctx["reviewers_assignment_id"]
    if not invitation_id:
        fail("no_assignment_invitation", "venue exposes no deployed reviewer assignment invitation")
    try:
        note = client.get_note(args.submission) if not args.submission.isdigit() else None
        if note is None:
            notes = client.get_all_notes(
                invitation=ctx["submission_id"], number=int(args.submission)
            )
            if not notes:
                fail("submission_not_found", f"no submission numbered {args.submission}")
            note = notes[0]
    except Exception as exc:
        fail("submission_not_found", str(exc))

    try:
        if args.remove:
            client.delete_edges(
                invitation=invitation_id, head=note.id, tail=args.reviewer, wait_to_finish=True
            )
            action = "removed"
        else:
            from openreview.api import Edge

            client.post_edge(
                Edge(
                    invitation=invitation_id,
                    head=note.id,
                    tail=args.reviewer,
                    signatures=[client.profile.id],
                    weight=1,
                )
            )
            action = "added"
    except Exception as exc:
        fail("assignment_failed", str(exc))
    out(
        {
            "ok": True,
            "action": action,
            "venue_id": args.venue,
            "submission": note.number,
            "reviewer": args.reviewer,
        }
    )


FORUM_ID_RE = re.compile(r"id=([A-Za-z0-9_-]+)")


def resolve_submission_pdf(client, note):
    """Locate the PDF for one author submission.

    Commitment venues (EMNLP 2026) store no PDF of their own: the note carries a
    `paper_link` pointing at the ARR forum that holds the real paper, so the link is
    followed once. Returns (pdf_note, source) or (None, reason); the caller downloads,
    since a listing pass should not pull megabytes it may not need.
    """
    if value_of(note.content, "pdf"):
        return note, "direct"
    link = value_of(note.content, "paper_link") or ""
    match = FORUM_ID_RE.search(link)
    if not match:
        return None, "no_pdf_and_no_paper_link"
    try:
        return client.get_note(match.group(1)), "paper_link"
    except Exception as exc:
        return None, f"paper_link_unreadable: {exc}"


def cmd_author_submissions(args):
    client = connect()
    profile_id = client.profile.id
    try:
        notes = client.get_all_notes(
            content={"authorids": profile_id}, invitation=f"{args.venue}/-/Submission"
        )
    except Exception as exc:
        fail("venue_unreadable", str(exc), venue_id=args.venue)

    target_dir = args.download_dir
    if target_dir:
        os.makedirs(target_dir, exist_ok=True)

    submissions = []
    for note in notes:
        venue_label = value_of(note.content, "venue") or ""
        # Withdrawn and desk-rejected papers are not going to be revised, so warning their
        # authors about references is noise. Kept in the output, flagged, and not downloaded.
        withdrawn = "withdraw" in venue_label.lower() or "desk reject" in venue_label.lower()
        entry = {
            "number": note.number,
            "id": note.id,
            "title": value_of(note.content, "title"),
            "venue": venue_label,
            "withdrawn": withdrawn,
            "authors": value_of(note.content, "authors") or [],
        }
        if withdrawn and not args.include_withdrawn:
            entry["skipped"] = "withdrawn"
            submissions.append(entry)
            continue
        pdf_note, source = resolve_submission_pdf(client, note)
        if pdf_note is None:
            entry["skipped"] = source
            submissions.append(entry)
            continue
        entry["pdf_source"] = source
        entry["pdf_note_id"] = pdf_note.id
        if target_dir:
            try:
                blob = client.get_pdf(pdf_note.id)
            except Exception as exc:
                entry["skipped"] = f"pdf_unreadable: {exc}"
                submissions.append(entry)
                continue
            path = os.path.join(target_dir, f"{note.number}-{pdf_note.id}.pdf")
            with open(path, "wb") as handle:
                handle.write(blob)
            entry["pdf_path"] = path
            entry["pdf_bytes"] = len(blob)
        submissions.append(entry)

    out(
        {
            "ok": True,
            "venue_id": args.venue,
            "profile_id": profile_id,
            "submissions": submissions,
            "downloaded": sum(1 for s in submissions if s.get("pdf_path")),
            "skipped": sum(1 for s in submissions if s.get("skipped")),
        }
    )


def main():
    parser = argparse.ArgumentParser(description="AdminBot OpenReview bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("discover")

    p = sub.add_parser("status")
    p.add_argument("--venue", required=True)
    p.add_argument("--role", required=True, choices=["reviewer", "ac", "sac"])

    p = sub.add_parser("message")
    p.add_argument("--invitation", required=True)
    p.add_argument("--signature", required=True)
    p.add_argument("--groups", required=True, help="comma-separated recipient group ids")
    p.add_argument("--subject", required=True)
    p.add_argument("--body-file", required=True, help='path, or "-" for stdin')
    p.add_argument("--send", action="store_true", help="without this the payload is only echoed")

    p = sub.add_parser("load-form")
    p.add_argument("--venue", required=True)
    p.add_argument("--role", required=True, choices=["reviewer", "ac", "sac"])

    p = sub.add_parser("assign")
    p.add_argument("--venue", required=True)
    p.add_argument("--submission", required=True, help="submission number or note id")
    p.add_argument("--reviewer", required=True, help="tilde id of the reviewer")
    p.add_argument("--remove", action="store_true", help="remove instead of add")

    p = sub.add_parser("author-submissions")
    p.add_argument("--venue", required=True)
    p.add_argument("--download-dir", help="write each PDF here; omit to only list")
    p.add_argument(
        "--include-withdrawn",
        action="store_true",
        help="also fetch withdrawn/desk-rejected submissions",
    )

    args = parser.parse_args()
    handlers = {
        "discover": cmd_discover,
        "status": cmd_status,
        "message": cmd_message,
        "load-form": cmd_load_form,
        "assign": cmd_assign,
        "author-submissions": cmd_author_submissions,
    }
    try:
        handlers[args.command](args)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
