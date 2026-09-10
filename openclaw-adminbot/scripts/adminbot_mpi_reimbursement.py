"""Fill the MPI IS "Reimbursement of travel costs for external guests" AcroForm.

Separate from the DCS path in adminbot-reimbursement-from-email.py because the two share nothing:
that one writes an Excel workbook and a Word trip summary, this one fills a PDF form with 67
fields and has to work around two digital-signature widgets.

Three things here are not obvious and are the reason this is a script rather than a few lines:

1. **NeedAppearances.** Filled values with no appearance stream are invisible in several viewers
   -- the value is in the PDF, the accountant sees a blank box. Setting the flag asks the viewer to
   build them.

2. **The signature fields.** The template carries two real `/Sig` widgets (`Date, Guest's
   signature` and the director's). Their presence makes macOS Preview and other viewers refuse to
   fill *or* annotate the whole document, so the claimant cannot sign it at all. The second file
   ships with those two widgets and `/SigFlags` removed, leaving every filled text field intact.

   Not a full flatten, and that is deliberate: the filled values live in each widget's `/AP`
   appearance stream, so dropping all annotations -- the obvious way to flatten -- takes the text
   with them and produces a blank form. Removing only what locks the document keeps the values on
   screen and is what the claimant can actually sign over.

3. **Overflow is silent.** A string longer than its field is truncated on screen while the full
   value sits in the PDF. Long free-text values are shortened here rather than discovered by the
   secretariat.

Usage: adminbot_mpi_reimbursement.py fill INPUT_JSON OUTPUT_DIR
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject

USER_FORMS = Path.home() / ".openclaw" / "skills" / "adminbot-reimbursements" / "forms"
BUNDLED_FORMS = Path(__file__).resolve().parents[1] / (
    "extensions/adminbot/skills/adminbot-reimbursements/forms"
)
TEMPLATE_NAME = "MPI_IS_Travel_Reimbursement.pdf"

# The institute pre-fills this and the rate is theirs to set, not ours to compute.
KM_RATE = "0.30"

# Free-text fields whose width is far below what a claimant will type. Measured off the template:
# these truncate rather than wrap, so a reason longer than this is shortened with an ellipsis and
# the full text goes in the covering email instead.
FIELD_LIMITS = {
    "Reason for stay or activity at the institute": 90,
    "Bus/Taxi/Public/transport/other": 40,
    "Flight": 40,
    "Train": 40,
    "Hotel": 40,
}


def resolve_template() -> Path:
    """Host copy wins, so a site can carry an updated form without a redeploy."""
    for base in (USER_FORMS, BUNDLED_FORMS):
        candidate = base / TEMPLATE_NAME
        if candidate.is_file():
            return candidate
    raise SystemExit(f"missing template {TEMPLATE_NAME} in {USER_FORMS} or {BUNDLED_FORMS}")


def money(value) -> str:
    """Two decimals, or blank. A blank cell is how the form says 'not claimed'; 0.00 is a claim."""
    if value in (None, ""):
        return ""
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def clip(field: str, value: str) -> str:
    limit = FIELD_LIMITS.get(field)
    if not limit or len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def build_fields(data: dict) -> dict:
    """Map the draft onto the template's own field names.

    The names are the institute's and are not self-explanatory (`Bus/Taxi/Public transport/other
    costs 1 in €`), so this mapping is the one place they appear. Registration fees have no line of
    their own on the form and go on the bus/taxi/other line, labelled -- which is what the
    secretariat expects.
    """
    claimant = data.get("claimant") or {}
    bank = data.get("bank") or {}
    trip = data.get("trip") or {}
    costs = data.get("costs") or {}

    fields: dict[str, str] = {
        "Name": claimant.get("name", ""),
        "Adress": claimant.get("address_line1", ""),
        "Adress 2": claimant.get("address_line2", ""),
        "Zip, City": claimant.get("zip_city", ""),
        "Country": claimant.get("country", ""),
        "E-Mail": claimant.get("email", ""),
        "Reason for stay or activity at the institute": clip(
            "Reason for stay or activity at the institute", trip.get("reason", "")
        ),
        "Responsible MPI Person": trip.get("responsible_person", ""),
        "Cost center/Project": trip.get("cost_center", ""),
        "Stay at the institute from - dd.mm.yy": trip.get("stay_from", ""),
        "Stay at the institute to - dd.mm.yy": trip.get("stay_to", ""),
        "from": trip.get("travel_from", ""),
        "to": trip.get("travel_to", ""),
        "Account Holder": bank.get("account_holder", ""),
        "Name of Bank": bank.get("bank_name", ""),
        "IBAN": bank.get("iban", ""),
        "SWIFT/BIC": bank.get("swift", ""),
        "Account number": bank.get("account_number", ""),
        "Routing number": bank.get("routing_number", ""),
        # Pre-filled by the institute; carried so a regenerated form still shows it.
        "€/Km": KM_RATE,
    }

    # Cost lines. Each has a label, the original amount with its currency, and the EUR figure --
    # the three columns the form actually has. EUR is what the institute pays against (R-MPI.3).
    for key, label_field, orig_field, eur_field in (
        ("flight", "Flight", "Flight costs 1", "Flight costs 1 in €"),
        ("flight_2", None, "Flight costs 2", "Flight costs 2 in €"),
        ("train", "Train", "Train costs 1", "Train costs 1 in €"),
        ("train_2", None, "Train costs 2", "Train costs 2 in €"),
        (
            "other_1",
            "Bus/Taxi/Public/transport/other",
            "Bus/Taxi/Public transport/other costs 1",
            "Bus/Taxi/Public transport/other costs 1 in €",
        ),
        (
            "other_2",
            None,
            "Bus/Taxi/Public transport/other costs 2",
            "Bus/Taxi/Public transport/other costs 2 in €",
        ),
        (
            "other_3",
            None,
            "Bus/Taxi/Public transport/other costs 3",
            "Bus/Taxi/Public transport/other costs 3 in €",
        ),
        (
            "other_4",
            None,
            "Bus/Taxi/Public transport/other costs 4",
            "Bus/Taxi/Public transport/other costs 4 in €",
        ),
        ("hotel", "Hotel", "Hotel costs", "Hotel costs in €"),
    ):
        line = costs.get(key) or {}
        if label_field and line.get("label"):
            fields[label_field] = clip(label_field, str(line["label"]))
        if line.get("amount") not in (None, ""):
            fields[orig_field] = money(line.get("amount"))
        if line.get("eur") not in (None, ""):
            fields[eur_field] = money(line.get("eur"))

    if costs.get("km"):
        fields["Km"] = str(costs["km"])
    if costs.get("private_car_eur") not in (None, ""):
        fields["Private Car costs"] = money(costs.get("private_car_eur"))
    if data.get("total_eur") not in (None, ""):
        fields["Total Amount in €"] = money(data.get("total_eur"))

    # Blank entries are dropped rather than written: an empty string still clears a template value
    # a host copy might carry, but writing "" into every unused currency box leaves the form
    # looking filled-in-and-zeroed rather than not claimed (see R1.8).
    return {name: value for name, value in fields.items() if value not in (None, "")}


def fill(template: Path, values: dict, live: Path, flat: Path) -> list[str]:
    reader = PdfReader(str(template))
    writer = PdfWriter()
    writer.append(reader)

    # Ask viewers to build appearance streams for the values we set; without this the text is in
    # the file but invisible in several readers.
    writer.set_need_appearances_writer(True)

    known = set((reader.get_fields() or {}).keys())
    unknown = sorted(set(values) - known)
    for page in writer.pages:
        writer.update_page_form_field_values(page, {k: v for k, v in values.items() if k in known})
    with live.open("wb") as handle:
        writer.write(handle)

    # The signable copy: same document with the two /Sig widgets gone.
    #
    # Deliberately not a full flatten. Each filled value lives in its widget's /AP stream, so
    # deleting /Annots -- the obvious flatten -- deletes the text too and writes out a blank form.
    # That is a real failure this script hit before it was verified; see the module docstring.
    flat_writer = PdfWriter()
    flat_writer.append(PdfReader(str(live)))
    flat_writer.set_need_appearances_writer(True)
    for page in flat_writer.pages:
        annots = page.get("/Annots")
        if not annots:
            continue
        keep = [a for a in annots if a.get_object().get("/FT") != "/Sig"]
        page[NameObject("/Annots")] = ArrayObject(keep)
    root = flat_writer._root_object
    # Resolved rather than used as-is: /AcroForm is an indirect reference in this template, and an
    # IndirectObject does not support item assignment or deletion.
    acroform = root.get("/AcroForm")
    acroform = acroform.get_object() if acroform is not None else None
    if acroform is not None:
        # /SigFlags is the other half of the lock: it tells a viewer the document expects a
        # signature, which some readers treat as reason enough to refuse annotation.
        if "/SigFlags" in acroform:
            del acroform[NameObject("/SigFlags")]
        fields = acroform.get("/Fields")
        if fields is not None:
            acroform[NameObject("/Fields")] = ArrayObject(
                [f for f in fields if f.get_object().get("/FT") != "/Sig"]
            )
    with flat.open("wb") as handle:
        flat_writer.write(handle)
    return unknown


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] != "fill":
        raise SystemExit("usage: adminbot_mpi_reimbursement.py fill INPUT_JSON OUTPUT_DIR")
    data = json.loads(Path(sys.argv[2]).read_text())
    output_dir = Path(sys.argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)

    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", str((data.get("claimant") or {}).get("name") or "claimant"))
    safe = safe.strip("_") or "claimant"
    live = output_dir / f"MPI_IS_Reimbursement_{safe}.pdf"
    flat = output_dir / f"MPI_IS_Reimbursement_{safe}_to_sign.pdf"

    values = build_fields(data)
    unknown = fill(resolve_template(), values, live, flat)
    print(
        json.dumps(
            {
                "files": [str(live), str(flat)],
                "fields_written": len(values),
                # Named rather than swallowed: a mapping that has drifted from the template is a
                # form with silently empty boxes, and this is the only place it shows.
                "unknown_fields": unknown,
            }
        )
    )


if __name__ == "__main__":
    main()
