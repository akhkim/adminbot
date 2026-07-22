#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import sys
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path

from docx import Document
from openpyxl import load_workbook

FORMS = Path(
    os.environ.get(
        "ADMINBOT_REIMBURSEMENT_FORMS_DIR",
        Path.home() / ".openclaw" / "skills" / "adminbot-reimbursements" / "forms",
    )
)
COMPUTE_EXPENSE_TEMPLATE = "Compute_Expense_Form.xlsx"
TRIP_SUMMARY_TEMPLATE = "Trip_Summary_Form.docx"


def extract_file(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json"}:
        return path.read_text(errors="replace")
    if suffix == ".docx":
        doc = Document(path)
        paragraphs = [p.text for p in doc.paragraphs]
        tables = [" | ".join(cell.text for cell in row.cells) for table in doc.tables for row in table.rows]
        return "\n".join(paragraphs + tables)
    if suffix == ".xlsx":
        wb = load_workbook(path, data_only=True, read_only=True)
        lines = []
        for ws in wb.worksheets:
            lines.append(f"SHEET: {ws.title}")
            for row in ws.iter_rows(values_only=True):
                values = [str(value) for value in row if value not in (None, "")]
                if values:
                    lines.append(" | ".join(values))
        return "\n".join(lines)
    if suffix == ".pdf" and shutil.which("pdftotext"):
        result = subprocess.run(["pdftotext", str(path), "-"], check=False, capture_output=True, text=True, timeout=45)
        return result.stdout
    if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff"} and shutil.which("tesseract"):
        result = subprocess.run(["tesseract", str(path), "stdout"], check=False, capture_output=True, text=True, timeout=45)
        return result.stdout
    return f"[{path.name}: unsupported text extraction; retain as supporting attachment]"


def require_template(name: str) -> Path:
    template = FORMS / name
    if not template.is_file():
        raise FileNotFoundError(f"required reimbursement template is missing: {template}")
    return template


def excel_date(value):
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except ValueError:
            pass
    return str(value)


CATEGORY_COLUMNS = {
    "hotel": {"canada": "K", "usa": "L", "international": "L"},
    "accommodation": {"canada": "K", "usa": "L", "international": "L"},
    "rail": {"canada": "M", "usa": "N", "international": "N"},
    "bus": {"canada": "M", "usa": "N", "international": "N"},
    "transit": {"canada": "O", "usa": "O", "international": "O"},
    "car rental": {"canada": "P", "usa": "P", "international": "P"},
    "meal": {"canada": "Q", "usa": "S", "international": "S"},
    "food": {"canada": "Q", "usa": "S", "international": "S"},
    "taxi": {"canada": "T", "usa": "V", "international": "V"},
    "rideshare": {"canada": "T", "usa": "V", "international": "V"},
    "uber": {"canada": "T", "usa": "V", "international": "V"},
    "lyft": {"canada": "T", "usa": "V", "international": "V"},
    "conference": {"canada": "W", "usa": "W", "international": "W"},
    "registration": {"canada": "W", "usa": "W", "international": "W"},
    "hospitality": {"canada": "X", "usa": "X", "international": "X"},
    "parking": {"canada": "Z", "usa": "Z", "international": "Z"},
}


def normalized_category(category: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", category.strip().lower()).strip()


def category_column(expense: dict) -> str:
    normalized = normalized_category(str(expense.get("category") or "other"))
    region = str(expense.get("region") or "international").lower()
    if "airfare" in normalized or "flight" in normalized or "air travel" in normalized:
        columns = (
            {"canada": "H", "usa": "I", "international": "J"}
            if expense.get("airfare_class") == "above_economy"
            else {"canada": "E", "usa": "F", "international": "G"}
        )
        return columns.get(region, columns["international"])
    for key, columns in CATEGORY_COLUMNS.items():
        if key in normalized:
            return columns.get(region, columns["international"])
    return "AA"


def canadian_tax_row(expense: dict, rows: tuple[int, int, int]) -> int:
    return {
        "ontario": rows[0],
        "atlantic_canada": rows[1],
        "other_canada": rows[2],
    }.get(str(expense.get("tax_region") or ""), rows[2])


def main_amount_row(expense: dict, other_rows: dict[str, int]) -> int:
    category = normalized_category(str(expense.get("category") or "other"))
    region = str(expense.get("region") or "international").lower()
    canada = region == "canada"
    if "airfare" in category or "flight" in category or "air travel" in category:
        base = 14 if expense.get("airfare_class") == "above_economy" else 11
        return base if canada else base + (1 if region == "usa" else 2)
    if "hotel" in category or "accommodation" in category:
        return canadian_tax_row(expense, (17, 18, 19)) if canada else 20
    if "per diem" in category or "allowance" in category:
        return 21 if canada else 22
    if "mileage" in category or "kilomet" in category:
        return 23
    if "rail" in category or "bus" in category:
        return 24 if canada else 25
    if "transit" in category:
        return 26
    if "car rental" in category:
        return canadian_tax_row(expense, (27, 28, 29)) if canada else 30
    if "meal" in category or "food" in category:
        if not canada:
            return 34
        if expense.get("tax_region") == "ontario":
            return 32 if expense.get("includes_tip") else 31
        return 33
    if any(key in category for key in ("taxi", "rideshare", "uber", "lyft")):
        if not canada:
            return 38
        if expense.get("tax_region") == "ontario":
            return 36 if expense.get("includes_tip") else 35
        return 37
    if "conference" in category or "registration" in category:
        return 39
    if "hospitality" in category:
        return 40 if canada else 41
    if "parking" in category and canada:
        return 42
    label = str(expense.get("category") or "Other").strip()[:30] or "Other"
    if label not in other_rows:
        if len(other_rows) >= 4:
            label = "Other expenses"
        other_rows.setdefault(label, 43 + min(len(other_rows), 3))
    return other_rows[label]


def requested_currency(data: dict) -> str:
    currency = str(data.get("currency") or "CAD").upper()
    if currency == "OTHER":
        return str(data.get("other_currency") or "OTHER").upper()
    return currency


def fill_workbook(data: dict, output: Path) -> None:
    wb = load_workbook(require_template(COMPUTE_EXPENSE_TEMPLATE))
    main = wb["Reimbursement Form"]
    main["A10"] = data.get("personnel_number") or ""
    main["B10"] = data.get("travel_period") or data.get("trip_dates") or ""
    main["A12"] = data.get("claimant_name") or ""
    main["A14"] = data.get("claimant_address") or ""
    main["A18"] = data.get("purpose") or ""
    main["A28"] = excel_date(data.get("prepared_date") or date.today().isoformat())
    main["A38"] = data.get("claimant_name") or ""
    main["C38"] = data.get("claimant_title") or ""
    currency = str(data.get("currency", "CAD")).upper()
    for cell in ("I4", "I5", "I6"):
        main[cell] = ""
    main[{"CAD": "I4", "USD": "I5"}.get(currency, "I6")] = "X"
    if currency == "OTHER":
        main["J7"] = data.get("other_currency") or ""

    summary = wb["Expense Summary"]
    other_labels: dict[str, str] = {}
    main_other_rows: dict[str, int] = {}
    for row in range(11, 50):
        main[f"L{row}"] = None
    for index, expense in enumerate(data.get("expenses", [])[:30], start=4):
        summary[f"B{index}"] = expense.get("receipt_number") or index - 3
        summary[f"C{index}"] = excel_date(expense.get("date"))
        summary[f"D{index}"] = expense.get("description") or expense.get("category") or "Expense"
        column = category_column(expense)
        if column == "AA":
            label = str(expense.get("category") or "Other")[:30]
            column = other_labels.setdefault(label, ("AA", "AB", "AC", "AD")[min(len(other_labels), 3)])
            summary[f"{column}2"] = label
        amount = float(expense.get("amount") or 0)
        summary[f"{column}{index}"] = amount
        row = main_amount_row(expense, main_other_rows)
        main[f"L{row}"] = float(main[f"L{row}"].value or 0) + amount
    main["L47"] = "=SUM(L11:L46)"
    main["L48"] = None
    main["L49"] = "X"
    calculation = getattr(wb, "calculation", None)
    if calculation is not None:
        calculation.fullCalcOnLoad = True
        calculation.forceFullCalc = True
    wb.save(output)


def replace_paragraph(paragraph, text: str) -> None:
    run_properties = (
        deepcopy(paragraph.runs[0]._r.rPr)
        if paragraph.runs and paragraph.runs[0]._r.rPr is not None
        else None
    )
    paragraph_properties = paragraph._p.pPr
    for child in list(paragraph._p):
        if paragraph_properties is None or child is not paragraph_properties:
            paragraph._p.remove(child)
    run = paragraph.add_run(text)
    if run_properties is not None:
        run._r.insert(0, run_properties)


def set_cell_text(cell, text: str) -> None:
    replace_paragraph(cell.paragraphs[0], text)
    for paragraph in cell.paragraphs[1:]:
        replace_paragraph(paragraph, "")


def trip_expense_groups(data: dict) -> list[tuple[str, float]]:
    groups: dict[str, float] = {}
    for expense in data.get("expenses", []):
        category = normalized_category(str(expense.get("category") or "Other"))
        if "hotel" in category or "accommodation" in category:
            label = "Hotel / accommodation"
        elif "airfare" in category or "flight" in category or "air travel" in category:
            label = "Flight / airfare"
        elif "meal" in category or "food" in category or "per diem" in category:
            label = "Meals / per diem"
        elif any(
            key in category
            for key in (
                "taxi",
                "rideshare",
                "uber",
                "lyft",
                "rail",
                "bus",
                "transit",
                "car rental",
                "parking",
                "mileage",
            )
        ):
            label = "Ground transportation"
        elif "conference" in category or "registration" in category:
            label = "Conference registration"
        elif "hospitality" in category:
            label = "Hospitality"
        else:
            label = str(expense.get("category") or "Other expenses").strip() or "Other expenses"
        groups[label] = groups.get(label, 0.0) + float(expense.get("amount") or 0)
    items = list(groups.items())
    if len(items) <= 5:
        return items
    return items[:4] + [("Other expenses", sum(amount for _, amount in items[4:]))]


def fill_trip_summary(data: dict, output: Path) -> None:
    doc = Document(require_template(TRIP_SUMMARY_TEMPLATE))
    values = {
        1: data.get("trip_title") or "Travel reimbursement",
        2: data.get("trip_dates") or data.get("travel_period") or "",
        3: data.get("trip_location") or "",
        5: "",
        6: "",
        7: "",
        10: data.get("claimant_name") or "",
        11: data.get("claimant_email") or "",
        13: data.get("claimant_title") or "",
        16: data.get("purpose") or "",
    }
    for index, value in values.items():
        if index < len(doc.paragraphs):
            replace_paragraph(doc.paragraphs[index], str(value))
    if doc.tables:
        table = doc.tables[0]
        groups = trip_expense_groups(data)
        currency_label = requested_currency(data)
        for index, row in enumerate(table.rows[:-1]):
            if index < len(groups):
                label, amount = groups[index]
                set_cell_text(row.cells[0], label)
                set_cell_text(row.cells[1], f"{currency_label} {amount:.2f}")
            else:
                set_cell_text(row.cells[0], "")
                set_cell_text(row.cells[1], "")
        set_cell_text(table.rows[-1].cells[0], "TOTAL")
        total = sum(float(expense.get("amount") or 0) for expense in data.get("expenses", []))
        set_cell_text(table.rows[-1].cells[1], f"{currency_label} {total:.2f}")
    attachments = [Path(name).name[:120] for name in data.get("supporting_files", []) if name]
    enclosure_lines = attachments[:3]
    if len(attachments) > 3:
        count = len(attachments) - 3
        enclosure_lines.append(
            f"{count} additional supporting {'file' if count == 1 else 'files'} attached"
        )
    for offset, paragraph_index in enumerate(range(23, 27)):
        replace_paragraph(
            doc.paragraphs[paragraph_index],
            enclosure_lines[offset] if offset < len(enclosure_lines) else "",
        )
    doc.save(output)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: helper extract FILE... | fill INPUT_JSON OUTPUT_DIR")
    if sys.argv[1] == "extract":
        for item in sys.argv[2:]:
            path = Path(item)
            print(f"\n--- {path.name} ---\n{extract_file(path)}")
        return
    if sys.argv[1] != "fill" or len(sys.argv) != 4:
        raise SystemExit("usage: helper fill INPUT_JSON OUTPUT_DIR")
    data = json.loads(Path(sys.argv[2]).read_text())
    output_dir = Path(sys.argv[3])
    output_dir.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(data.get("claimant_name") or "claimant")).strip("_")
    workbook = output_dir / f"Compute_Expense_Form_{safe_name}.xlsx"
    trip = output_dir / f"Trip_Summary_Form_{safe_name}.docx"
    fill_workbook(data, workbook)
    fill_trip_summary(data, trip)
    print(json.dumps({"files": [str(workbook), str(trip)]}))


if __name__ == "__main__":
    main()
