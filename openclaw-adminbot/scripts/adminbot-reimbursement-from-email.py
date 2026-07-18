#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

from docx import Document
from openpyxl import load_workbook

FORMS = Path.home() / ".openclaw" / "skills" / "adminbot-reimbursements" / "forms"


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


def choose_template(data: dict) -> Path:
    claimant = str(data.get("claimant_name", "")).strip().lower()
    return FORMS / ("Compute_Expense_Form_Zhijing.xlsx" if claimant in {"zhijing jin", "jin, zhijing"} else "Compute_Expense_Form_Member.xlsx")


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
    "airfare": {"canada": "E", "usa": "F", "international": "G"},
    "flight": {"canada": "E", "usa": "F", "international": "G"},
    "hotel": {"canada": "K", "usa": "L", "international": "L"},
    "accommodation": {"canada": "K", "usa": "L", "international": "L"},
    "rail": {"canada": "M", "usa": "N", "international": "N"},
    "bus": {"canada": "M", "usa": "N", "international": "N"},
    "transit": {"canada": "O", "usa": "O", "international": "O"},
    "car rental": {"canada": "P", "usa": "P", "international": "P"},
    "meal": {"canada": "Q", "usa": "S", "international": "S"},
    "taxi": {"canada": "T", "usa": "V", "international": "V"},
    "conference": {"canada": "W", "usa": "W", "international": "W"},
    "registration": {"canada": "W", "usa": "W", "international": "W"},
    "hospitality": {"canada": "X", "usa": "X", "international": "X"},
    "parking": {"canada": "Z", "usa": "Z", "international": "Z"},
}


def category_column(category: str, region: str) -> str:
    normalized = category.strip().lower()
    for key, columns in CATEGORY_COLUMNS.items():
        if key in normalized:
            return columns.get(region, columns["international"])
    return "AA"


def fill_workbook(data: dict, output: Path) -> None:
    wb = load_workbook(choose_template(data))
    main = wb["Reimbursement Form"]
    main["A10"] = data.get("personnel_number") or ""
    main["B10"] = data.get("travel_period") or data.get("trip_dates") or ""
    main["A12"] = data.get("claimant_name") or ""
    main["A14"] = data.get("claimant_address") or ""
    main["A18"] = data.get("purpose") or ""
    main["A38"] = data.get("claimant_name") or ""
    main["C38"] = data.get("claimant_title") or ""
    currency = str(data.get("currency", "CAD")).upper()
    for cell in ("I4", "I5", "I6"):
        main[cell] = ""
    main[{"CAD": "I4", "USD": "I5"}.get(currency, "I6")] = "X"
    summary = wb["Expense Summary"]
    other_labels = {}
    for index, expense in enumerate(data.get("expenses", [])[:30], start=4):
        summary[f"C{index}"] = excel_date(expense.get("date"))
        summary[f"D{index}"] = expense.get("description") or expense.get("category") or "Expense"
        region = str(expense.get("region") or "international").lower()
        column = category_column(str(expense.get("category") or "other"), region)
        if column == "AA":
            label = str(expense.get("category") or "Other")[:30]
            column = other_labels.setdefault(label, ("AA", "AB", "AC", "AD")[min(len(other_labels), 3)])
            summary[f"{column}2"] = label
        summary[f"{column}{index}"] = float(expense.get("amount") or 0)
    wb.save(output)


def replace_paragraph(paragraph, text):
    if paragraph.runs:
        paragraph.runs[0].text = text
        for run in paragraph.runs[1:]:
            run.text = ""
    else:
        paragraph.text = text


def fill_trip_summary(data: dict, output: Path) -> None:
    doc = Document(FORMS / "Trip_Summary_Form.docx")
    values = {
        1: data.get("trip_title") or "Travel reimbursement",
        2: data.get("trip_dates") or data.get("travel_period") or "",
        3: data.get("trip_location") or "",
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
        totals = {}
        for expense in data.get("expenses", []):
            key = str(expense.get("category") or "Other")
            totals[key] = totals.get(key, 0.0) + float(expense.get("amount") or 0)
        for row in table.rows:
            label = row.cells[0].text.strip().lower()
            match = next((amount for category, amount in totals.items() if category.lower() in label or label in category.lower()), None)
            if match is not None:
                row.cells[1].text = f"{data.get('currency', 'CAD')} {match:.2f}"
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
    workbook = output_dir / f"Expense_Form_{safe_name}.xlsx"
    trip = output_dir / f"Trip_Summary_{safe_name}.docx"
    fill_workbook(data, workbook)
    fill_trip_summary(data, trip)
    print(json.dumps({"files": [str(workbook), str(trip)]}))


if __name__ == "__main__":
    main()

