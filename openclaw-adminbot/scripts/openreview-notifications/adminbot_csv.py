"""Normalize the OpenReview notifications CSV export to the JSON record shape."""
import csv
import io
from datetime import datetime, timezone


def parse_notifications_csv(text):
    csv.field_size_limit(25 * 1024 * 1024)
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff"), newline=""), strict=True)
    required = {"id", "date_utc", "venue_domain", "subject", "message"}
    try:
        headers = reader.fieldnames or []
        if not required.issubset(headers) or len(headers) != len(set(headers)):
            raise ValueError("CSV requires unique columns: id, date_utc, venue_domain, subject, message.")
        records = []
        for row in reader:
            number = reader.line_num
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"CSV row ending at line {number} has the wrong number of columns.")
            try:
                date = datetime.strptime(row["date_utc"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            except ValueError:
                raise ValueError(f"CSV line {number}: date_utc must be YYYY-MM-DD HH:MM:SS in UTC.") from None
            records.append({
                "id": row["id"], "cdate": int(date.timestamp() * 1000),
                "domain": row["venue_domain"], "invitation": row.get("invitation", ""),
                "status": row.get("status", ""),
                "content": {"subject": row["subject"], "text": row["message"]},
            })
            if len(records) > 10000:
                raise ValueError("Upload at most 10,000 notifications.")
        return records
    except csv.Error:
        raise ValueError("Malformed CSV: check quoted fields and embedded line breaks.") from None
