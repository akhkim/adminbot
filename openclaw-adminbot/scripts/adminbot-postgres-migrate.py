#!/usr/bin/env python3
"""Copy a quiesced AdminBot SQLite snapshot into a fresh PostgreSQL staging schema.

This is a data migration rehearsal, not a runtime backend switch. It needs only Python's
standard library and psql. It never writes to SQLite and never prints row contents.
"""

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shlex
import sqlite3
import struct
import subprocess
import sys


IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
SCHEMA = re.compile(r"^adminbot_migration_[a-z0-9_]+$")
TYPES = {"TEXT": "text COLLATE \"C\"", "INTEGER": "bigint", "REAL": "double precision"}
# This key deliberately joins fields with NUL in the SQLite application. PostgreSQL text
# cannot hold NUL, so the future PG store must encode/decode this column as UTF-8 bytea.
BYTEA_COLUMNS = {
    ("adminbot_cv_changes", "entry_key"),
    ("adminbot_feedback", "id"),
}
CHECKS = {
    "adminbot_director_status": ["id = 1"],
    "adminbot_email_scan": ["id = 1"],
    "adminbot_reference_scans": ["status IN ('running', 'completed', 'failed')"],
    "adminbot_openreview_citation_checks": ["status IN ('completed', 'unreadable', 'failed')"],
}
# Only these non-unique SQLite expression indexes exist in the deployed AdminBot schema.
# They are access paths, not constraints; the PG runtime queries still need their own review.
EXPRESSION_INDEXES = {
    "adminbot_help_requests_status_hours_idx": (
        "json_extract(payload_json, '$.status'), json_extract(payload_json, '$.hours_per_week'), paper_id",
        "((payload_json::jsonb ->> 'status') COLLATE \"C\") NULLS FIRST, "
        "((payload_json::jsonb ->> 'hours_per_week')::numeric) NULLS FIRST, "
        "paper_id",
    ),
    "adminbot_lab_members_name_idx": (
        "json_extract(payload_json, '$.name'), id",
        "((payload_json::jsonb ->> 'name') COLLATE \"C\") NULLS FIRST, id",
    ),
    "adminbot_lab_members_name_nocase_idx": (
        "json_extract(payload_json, '$.name') COLLATE NOCASE, id",
        "(translate(payload_json::jsonb ->> 'name', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
        "'abcdefghijklmnopqrstuvwxyz') COLLATE \"C\") NULLS FIRST, id",
    ),
    "adminbot_papers_title_idx": (
        "json_extract(payload_json, '$.title'), id",
        "((payload_json::jsonb ->> 'title') COLLATE \"C\") NULLS FIRST, id",
    ),
    "adminbot_papers_title_nocase_idx": (
        "json_extract(payload_json, '$.title') COLLATE NOCASE, id",
        "(translate(payload_json::jsonb ->> 'title', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
        "'abcdefghijklmnopqrstuvwxyz') COLLATE \"C\") NULLS FIRST, id",
    ),
}
PENDING_INDEXES = {
    "adminbot_pending_registrations_email_unique_idx": (
        "CREATE UNIQUE INDEX adminbot_pending_registrations_email_unique_idx "
        "ON adminbot_account_registrations(lower(email)) WHERE status = 'pending'"
    ),
    "adminbot_pending_claims_member_unique_idx": (
        "CREATE UNIQUE INDEX adminbot_pending_claims_member_unique_idx "
        "ON adminbot_account_registrations(member_id) "
        "WHERE status = 'pending' AND kind = 'claim' AND member_id IS NOT NULL"
    ),
}


class MigrationError(Exception):
    pass


def ident(value):
    if not IDENT.fullmatch(value) or len(value.encode("utf-8")) > 63:
        raise MigrationError("unsupported SQL identifier")
    return '"' + value + '"'


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def check_source(path):
    path = path.resolve(strict=True)
    if not path.is_file() or path.stat().st_mode & 0o222:
        raise MigrationError("source must be a read-only SQLite snapshot")
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm")):
        raise MigrationError("source has SQLite WAL/SHM sidecars; use a quiesced snapshot")
    return path


def checks_in(ddl):
    found = []
    for match in re.finditer(r"\bCHECK\s*\(", ddl, re.I):
        start = match.end()
        depth = 1
        quote = False
        index = start
        while index < len(ddl) and depth:
            char = ddl[index]
            if char == "'":
                if quote and index + 1 < len(ddl) and ddl[index + 1] == "'":
                    index += 2
                    continue
                quote = not quote
            elif not quote and char == "(":
                depth += 1
            elif not quote and char == ")":
                depth -= 1
            index += 1
        if depth:
            raise MigrationError("unbalanced source CHECK constraint")
        found.append(ddl[start : index - 1].strip())
    return found


def canonical(value):
    return re.sub(r"\s+", " ", value).strip().lower()


def table_model(db, name, ddl):
    ident(name)
    if not name.startswith("adminbot_"):
        raise MigrationError("source contains a non-AdminBot table")
    if not ddl:
        raise MigrationError("table has no ordinary SQLite DDL: " + name)
    if re.search(r"\b(WITHOUT\s+ROWID|AUTOINCREMENT|GENERATED|VIRTUAL|STRICT)\b", ddl, re.I):
        raise MigrationError("unsupported SQLite table feature in " + name)
    if re.search(r"\b(COLLATE|ON\s+CONFLICT|DEFERRABLE|INITIALLY)\b", ddl, re.I):
        raise MigrationError("unsupported table collation/constraint mode in " + name)
    observed = [canonical(value) for value in checks_in(ddl)]
    expected = [canonical(value) for value in CHECKS.get(name, [])]
    if observed != expected:
        raise MigrationError("unrecognized CHECK constraint in " + name)
    cols = db.execute("PRAGMA table_info(" + ident(name) + ")").fetchall()
    if not cols or any(not IDENT.fullmatch(col[1]) or col[2].upper() not in TYPES for col in cols):
        raise MigrationError("unsupported column name/type in " + name)
    if any((name, col[1]) in BYTEA_COLUMNS and col[2].upper() != "TEXT" for col in cols):
        raise MigrationError("bytea-mapped source column changed type in " + name)
    if any(col[1] == "_sqlite_rowid" for col in cols):
        raise MigrationError("reserved column already exists in " + name)
    pk = [col[1] for col in sorted(cols, key=lambda col: col[5]) if col[5]]
    if not pk:
        raise MigrationError("table has no primary key: " + name)
    fks = db.execute("PRAGMA foreign_key_list(" + ident(name) + ")").fetchall()
    indexes = []
    for _, index_name, unique, origin, partial in db.execute(
        "PRAGMA index_list(" + ident(name) + ")"
    ):
        if partial:
            sql_row = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (index_name,)
            ).fetchone()
            expected = PENDING_INDEXES.get(index_name) if name == "adminbot_account_registrations" else None
            if not unique or not expected or not sql_row or canonical(sql_row[0]) != canonical(expected):
                raise MigrationError("partial index needs manual review: " + index_name)
            # The PG-only indexes below enforce the same constraints for old and new snapshots.
            continue
        if origin == "pk":
            continue
        if origin not in ("c", "u"):
            raise MigrationError("unsupported index origin: " + index_name)
        keys = [row for row in db.execute("PRAGMA index_xinfo(" + ident(index_name) + ")") if row[5]]
        sql_row = db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (index_name,)).fetchone()
        sql = sql_row[0] if sql_row else None
        if any(key[1] < 0 for key in keys):
            mapping = EXPRESSION_INDEXES.get(index_name)
            if unique or not sql or not mapping:
                raise MigrationError("unsupported expression index: " + index_name)
            pattern = re.compile(
                r"^create\s+index(?:\s+if\s+not\s+exists)?\s+" + re.escape(index_name)
                + r"\s+on\s+" + re.escape(name) + r"\((.*)\)$", re.I | re.S
            )
            match = pattern.match(sql.strip())
            if not match or canonical(match.group(1)) != canonical(mapping[0]):
                raise MigrationError("expression index changed: " + index_name)
            index_keys = mapping[1]
        else:
            parts = []
            for _, _, col_name, descending, collation, _ in keys:
                if collation not in ("BINARY", "NOCASE"):
                    raise MigrationError("unsupported index collation: " + index_name)
                part = ident(col_name)
                if collation == "NOCASE":
                    if unique:
                        raise MigrationError("unique NOCASE index needs manual review: " + index_name)
                    part = ("translate(" + part + ", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
                            "'abcdefghijklmnopqrstuvwxyz') COLLATE \"C\"")
                source_col = next(col for col in cols if col[1] == col_name)
                nullable = not (source_col[3] or source_col[5])
                if descending:
                    part += " DESC"
                if nullable:
                    part += " NULLS LAST" if descending else " NULLS FIRST"
                parts.append(part)
            index_keys = ", ".join(parts)
        indexes.append((index_name, bool(unique), index_keys))
    return {"name": name, "columns": cols, "pk": pk, "checks": CHECKS.get(name, []),
            "fks": fks, "indexes": indexes}


def inspect(db):
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise MigrationError("SQLite integrity_check failed")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise MigrationError("SQLite foreign_key_check failed")
    objects = db.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    if any(kind in ("trigger", "view") for kind, _, _ in objects):
        raise MigrationError("triggers/views need manual migration")
    tables = [table_model(db, name, ddl) for kind, name, ddl in objects if kind == "table"]
    if not tables:
        raise MigrationError("no AdminBot tables found")
    if any(table["name"] == "adminbot_account_registrations" for table in tables):
        duplicate_email = db.execute(
            "SELECT 1 FROM adminbot_account_registrations WHERE status = 'pending' "
            "GROUP BY lower(email) HAVING count(*) > 1 LIMIT 1"
        ).fetchone()
        duplicate_member = db.execute(
            "SELECT 1 FROM adminbot_account_registrations "
            "WHERE status = 'pending' AND member_id IS NOT NULL "
            "GROUP BY member_id HAVING count(*) > 1 LIMIT 1"
        ).fetchone()
        if duplicate_email or duplicate_member:
            raise MigrationError("duplicate pending registration needs reconciliation before import")
    # Make plan catch unsupported defaults, indexes and FK actions before any PG connection.
    for table in tables:
        table_sql("adminbot_migration_preview", table)
        list(index_sql("adminbot_migration_preview", table))
        list(fk_sql("adminbot_migration_preview", table))
    return tables


def table_sql(schema, table):
    name = table["name"]
    pieces = ['"_sqlite_rowid" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL UNIQUE']
    for _, col_name, kind, not_null, default, _ in table["columns"]:
        if default is not None and not re.fullmatch(r"-?\d+|NULL|'(?:[^']|'')*'", default, re.I):
            raise MigrationError("unsupported default in " + name + "." + col_name)
        pg_type = "bytea" if (name, col_name) in BYTEA_COLUMNS else TYPES[kind.upper()]
        part = ident(col_name) + " " + pg_type
        if not_null:
            part += " NOT NULL"
        if default is not None:
            part += " DEFAULT " + default
        pieces.append(part)
    pieces.append("PRIMARY KEY (" + ", ".join(map(ident, table["pk"])) + ")")
    pieces.extend("CHECK (" + check + ")" for check in table["checks"])
    return "CREATE TABLE " + ident(schema) + "." + ident(name) + " (" + ", ".join(pieces) + ");\n"


def index_sql(schema, table):
    for name, unique, keys in table["indexes"]:
        yield ("CREATE UNIQUE INDEX " if unique else "CREATE INDEX ") + ident(name) + " ON " + ident(schema) + "." + ident(table["name"]) + " (" + keys + ");\n"
    if table["name"] == "adminbot_account_registrations":
        reserved = {
            "adminbot_account_registrations_pending_email_idx",
            "adminbot_account_registrations_pending_member_idx",
        }
        if any(name in reserved for name, _, _ in table["indexes"]):
            raise MigrationError("reserved PostgreSQL pending registration index name in source")
        target = ident(schema) + '."adminbot_account_registrations"'
        yield ("CREATE UNIQUE INDEX adminbot_account_registrations_pending_email_idx ON "
               + target + " (lower(email)) WHERE status = 'pending';\n")
        yield ("CREATE UNIQUE INDEX adminbot_account_registrations_pending_member_idx ON "
               + target + " (member_id) WHERE status = 'pending' AND kind = 'claim' "
               "AND member_id IS NOT NULL;\n")
    # The SQLite source has only (member_id, expires_at), which cannot serve
    # expiry-only cleanup. This additional PostgreSQL access path is intentional.
    if table["name"] == "adminbot_sessions" and not any(
        keys.startswith('"expires_at"') for _, _, keys in table["indexes"]
    ):
        name = "adminbot_sessions_expiry_lookup_idx"
        if any(index_name == name for index_name, _, _ in table["indexes"]):
            raise MigrationError("reserved PostgreSQL expiry index name in source")
        yield ("CREATE INDEX " + ident(name) + " ON " + ident(schema)
               + ".\"adminbot_sessions\" (\"expires_at\");\n")


def fk_sql(schema, table):
    groups = {}
    for fk in table["fks"]:
        groups.setdefault(fk[0], []).append(fk)
    for number, rows in groups.items():
        rows.sort(key=lambda row: row[1])
        referenced = rows[0][2]
        if any(row[2] != referenced or row[7] != "NONE" for row in rows):
            raise MigrationError("unsupported foreign key in " + table["name"])
        update, delete = rows[0][5:7]
        if update not in ("NO ACTION", "RESTRICT", "CASCADE", "SET NULL") or delete not in (
            "NO ACTION", "RESTRICT", "CASCADE", "SET NULL"
        ):
            raise MigrationError("unsupported foreign-key action in " + table["name"])
        yield (
            "ALTER TABLE " + ident(schema) + "." + ident(table["name"])
            + " ADD CONSTRAINT " + ident(table["name"] + "_fk_" + str(number))
            + " FOREIGN KEY (" + ", ".join(ident(row[3]) for row in rows) + ")"
            + " REFERENCES " + ident(schema) + "." + ident(referenced)
            + " (" + ", ".join(ident(row[4]) for row in rows) + ")"
            + " ON UPDATE " + update + " ON DELETE " + delete + ";\n"
        )


def sqlite_rows(db, table):
    return db.execute(
        "SELECT rowid, * FROM " + ident(table["name"]) + " ORDER BY rowid"
    )


def checked_value(value, kind, table, column, sentinel):
    if value is None:
        return sentinel
    if kind == "TEXT":
        if not isinstance(value, str) or value == sentinel:
            raise MigrationError("unsupported text value in " + table + "." + column)
        if (table, column) in BYTEA_COLUMNS:
            return '"\\x' + value.encode("utf-8").hex() + '"'
        if "\x00" in value:
            raise MigrationError("NUL text needs explicit bytea mapping in " + table + "." + column)
        # psql treats a physical line containing only '\.' as end-of-data even inside
        # quoted CSV in an inline COPY script. Reject its start before opening psql;
        # otherwise subsequent row text could be parsed as SQL.
        if value.startswith("\\.") or re.search(r"[\r\n]\\\.", value):
            raise MigrationError("unsafe psql COPY end marker in " + table + "." + column)
        return '"' + value.replace('"', '""') + '"'
    if kind == "INTEGER":
        if type(value) is not int:
            raise MigrationError("unsupported integer value in " + table + "." + column)
        return str(value)
    if kind == "REAL":
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise MigrationError("unsupported real value in " + table + "." + column)
        return repr(float(value))
    raise MigrationError("unsupported SQLite type")


def source_scan(db, tables, sentinel):
    counts = {}
    for table in tables:
        name = table["name"]
        count = 0
        for row in sqlite_rows(db, table):
            for value, col in zip(row[1:], table["columns"], strict=True):
                checked_value(value, col[2].upper(), name, col[1], sentinel)
                if col[5] and value is None:
                    raise MigrationError("null primary key in " + name)
                if col[1].endswith("_json") and value is not None:
                    try:
                        json.loads(value)
                    except (ValueError, TypeError):
                        raise MigrationError("invalid JSON in " + name + "." + col[1]) from None
            count += 1
        counts[name] = count
    return counts


def psql_args(command):
    args = shlex.split(command)
    if not args:
        raise MigrationError("empty psql command")
    return args + ["-X", "-q", "-v", "ON_ERROR_STOP=1"]


def send_import(db, tables, counts, schema, sentinel, command, path, source_hash):
    proc = subprocess.Popen(psql_args(command), stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    writer = io.TextIOWrapper(proc.stdin, encoding="utf-8", newline="")
    try:
        def emit(sql):
            writer.write(sql)

        emit("BEGIN; SET LOCAL search_path = pg_catalog;\n")
        emit("CREATE SCHEMA " + ident(schema) + ";\n")
        for table in tables:
            emit(table_sql(schema, table))
        for table in tables:
            columns = ["_sqlite_rowid"] + [col[1] for col in table["columns"]]
            emit("COPY " + ident(schema) + "." + ident(table["name"]) + " ("
                 + ", ".join(map(ident, columns)) + ") FROM STDIN WITH (FORMAT csv, NULL '"
                 + sentinel + "');\n")
            for row in sqlite_rows(db, table):
                fields = [str(row[0])]
                fields.extend(checked_value(value, col[2].upper(), table["name"], col[1], sentinel)
                              for value, col in zip(row[1:], table["columns"], strict=True))
                emit(",".join(fields) + "\n")
            emit("\\.\n")
        if digest(path) != source_hash:
            raise MigrationError("source snapshot changed during import")
        for table in tables:
            for sql in index_sql(schema, table):
                emit(sql)
        for table in tables:
            for sql in fk_sql(schema, table):
                emit(sql)
        for table in tables:
            qualified = ident(schema) + "." + ident(table["name"])
            emit("SELECT setval(pg_get_serial_sequence('" + qualified
                 + "', '_sqlite_rowid'), GREATEST(COALESCE(MAX(_sqlite_rowid), 0), 1), "
                 + "COALESCE(MAX(_sqlite_rowid), 0) >= 1) FROM " + qualified + ";\n")
        for table in tables:
            name = table["name"]
            emit("DO $$ BEGIN IF (SELECT count(*) FROM " + ident(schema) + "." + ident(name)
                 + ") <> " + str(counts[name]) + " THEN RAISE EXCEPTION 'row count mismatch';"
                 + " END IF; END $$;\n")
        emit("COMMIT;\n")
        writer.close()
        proc.wait()
        if proc.returncode:
            raise MigrationError("PostgreSQL import failed; transaction rolled back (details suppressed)")
    except (BrokenPipeError, OSError):
        raise MigrationError("PostgreSQL import failed; transaction rolled back (details suppressed)") from None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if not writer.closed:
            try:
                writer.close()
            except OSError:
                pass


def same(source, target):
    if isinstance(source, float):
        return isinstance(target, float) and struct.pack("!d", source) == struct.pack("!d", target)
    return source == target


def verify(db, tables, schema, sentinel, command):
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            break
        except OverflowError:
            limit //= 10
    for table in tables:
        name = table["name"]
        columns = ["_sqlite_rowid"] + [col[1] for col in table["columns"]]
        sql = "COPY (SELECT " + ", ".join(map(ident, columns)) + " FROM " + ident(schema)
        sql += "." + ident(name) + " ORDER BY \"_sqlite_rowid\") TO STDOUT WITH (FORMAT csv, NULL '"
        sql += sentinel + "', FORCE_QUOTE *);"
        proc = subprocess.Popen(psql_args(command) + ["-c", sql], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        reader = io.TextIOWrapper(proc.stdout, encoding="utf-8", newline="")
        try:
            target_rows = csv.reader(reader)
            count = 0
            for source_row in sqlite_rows(db, table):
                try:
                    target_row = next(target_rows)
                except StopIteration:
                    raise MigrationError("PostgreSQL has fewer rows in " + name) from None
                if len(target_row) != len(source_row):
                    raise MigrationError("PostgreSQL column count mismatch in " + name)
                kinds = ["INTEGER"] + [col[2].upper() for col in table["columns"]]
                for col_name, source_value, target_value, kind in zip(
                    columns, source_row, target_row, kinds, strict=True
                ):
                    if target_value == sentinel:
                        decoded = None
                    elif kind == "INTEGER":
                        decoded = int(target_value)
                    elif kind == "REAL":
                        decoded = float(target_value)
                    elif (name, col_name) in BYTEA_COLUMNS:
                        decoded = bytes.fromhex(target_value[2:]).decode("utf-8")
                    else:
                        decoded = target_value
                    if not same(source_value, decoded):
                        raise MigrationError("PostgreSQL value mismatch in " + name)
                count += 1
            try:
                next(target_rows)
            except StopIteration:
                pass
            else:
                raise MigrationError("PostgreSQL has extra rows in " + name)
            reader.close()
            if proc.wait() != 0:
                raise MigrationError("PostgreSQL verification query failed in " + name)
        finally:
            if not reader.closed:
                reader.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("plan", "apply"))
    parser.add_argument("--sqlite", required=True, type=Path, help="read-only, WAL-free snapshot")
    parser.add_argument("--schema", help="fresh adminbot_migration_* PostgreSQL schema")
    parser.add_argument("--source-sha256", help="required for apply; binds the exact source bytes")
    parser.add_argument("--expected-tables", type=int, help="required for apply")
    parser.add_argument("--psql-command", default="psql", help="psql argv; PG* env supplies credentials")
    args = parser.parse_args(argv)
    committed_schema = None
    try:
        path = check_source(args.sqlite)
        source_hash = digest(path)
        if args.mode == "apply":
            if not args.schema or not SCHEMA.fullmatch(args.schema):
                raise MigrationError("apply needs a fresh adminbot_migration_* schema")
            if not args.source_sha256 or source_hash != args.source_sha256.lower():
                raise MigrationError("source SHA-256 does not match")
            if args.expected_tables is None or args.expected_tables < 1:
                raise MigrationError("apply needs --expected-tables")
        # A frozen, sidecar-free snapshot can be opened immutable: even SQLite's WAL
        # shared-memory bookkeeping must not write beside the source.
        db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=5)
        try:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            tables = inspect(db)
            if args.mode == "apply" and len(tables) != args.expected_tables:
                raise MigrationError("source table count differs from expected")
            sentinel = "__ADMINBOT_NULL_" + os.urandom(16).hex() + "__"
            counts = source_scan(db, tables, sentinel)
            print("source_sha256=" + source_hash + " tables=" + str(len(tables))
                  + " rows=" + str(sum(counts.values())))
            print("bytea_utf8_columns=" + ",".join(".".join(pair) for pair in sorted(BYTEA_COLUMNS)))
            if args.mode == "apply":
                send_import(db, tables, counts, args.schema, sentinel, args.psql_command, path,
                            source_hash)
                committed_schema = args.schema
                verify(db, tables, args.schema, sentinel, args.psql_command)
                print("verified exact row values in all " + str(len(tables)) + " tables")
        finally:
            db.close()
    except (MigrationError, sqlite3.Error, OSError, ValueError, UnicodeError, csv.Error) as error:
        message = str(error) if isinstance(error, MigrationError) else "snapshot/connection failure"
        print("migration refused: " + message, file=sys.stderr)
        if committed_schema is not None:
            print("staging schema " + committed_schema
                  + " is UNVERIFIED; do not promote it; diagnose and clean it up manually",
                  file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
