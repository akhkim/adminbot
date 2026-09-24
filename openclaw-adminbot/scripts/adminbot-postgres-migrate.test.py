#!/usr/bin/env python3
"""Synthetic checks for the SQLite -> PostgreSQL staging importer."""

import importlib.util
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import tempfile
import unittest
import uuid


APP = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).with_name("adminbot-postgres-migrate.py")
SPEC = importlib.util.spec_from_file_location("adminbot_postgres_migrate", SCRIPT)
migrate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migrate)


def fixture(path):
    code = (
        "import { AdminBotSqliteStore } from './extensions/adminbot/src/persistence/sqlite.ts';"
        "const store = new AdminBotSqliteStore(process.env.ADMINBOT_TEST_DB); store.close();"
    )
    env = {**os.environ, "ADMINBOT_TEST_DB": str(path)}
    subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", code],
                   cwd=APP, env=env, check=True, capture_output=True, text=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE adminbot_email_effects (
          message_id TEXT NOT NULL, effect_key TEXT NOT NULL, status TEXT NOT NULL,
          result_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(message_id, effect_key));
        CREATE TABLE adminbot_email_scan (
          id INTEGER PRIMARY KEY CHECK (id = 1), scanned_through TEXT NOT NULL);
        CREATE TABLE adminbot_onboarding_threads (
          thread_id TEXT PRIMARY KEY, candidate_email TEXT NOT NULL,
          decision TEXT NOT NULL, source_message_id TEXT NOT NULL,
          status TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE adminbot_meeting_artifacts (
          file_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, meeting_id TEXT,
          status TEXT NOT NULL, processed_at TEXT NOT NULL);
    """)
    db.execute("INSERT INTO adminbot_lab_members VALUES (?, ?, ?, ?)",
               ("member-synthetic", "member", "2026-01-01T00:00:00.000Z",
                '{"name":"Ada Δ","bio":"line 1\\nline 2","empty":"","tags":["a,b"]}'))
    for member_id, display_name in (
        ("z-upper", "Éclair"), ("a-lower", "éclair"),
        ("ascii-upper", "Zed"), ("ascii-lower", "apple"),
    ):
        db.execute("INSERT INTO adminbot_lab_members VALUES (?, ?, ?, ?)",
                   (member_id, "member", "2026-01-01T00:00:00.000Z",
                    '{"name":"' + display_name + '"}'))
    db.execute("INSERT INTO adminbot_lab_members VALUES (?, ?, ?, ?)",
               ("null-name", "member", "2026-01-01T00:00:00.000Z", "{}"))
    db.execute("INSERT INTO adminbot_papers VALUES (?, ?, ?, ?)",
               ("paper-synthetic", "draft", "2026-01-01T00:00:00.000Z",
                '{"title":"A \\"quoted\\" paper","authors":[]}'))
    db.execute("INSERT INTO adminbot_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               ("proposal-synthetic", "pending", "test", "low", "hash-synthetic",
                "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "{}"))
    db.execute("INSERT INTO adminbot_deadline_submission_keys VALUES (?, ?, ?)",
               ("member-synthetic", "key-synthetic", "proposal-synthetic"))
    db.execute("INSERT INTO adminbot_cv_changes VALUES (?, ?, ?, ?, ?)",
               ("member-synthetic", "A paper\x00Ada Δ", "2026-01-01T00:00:00.000Z",
                "recent", '{"title":"A paper"}'))
    db.execute("INSERT INTO adminbot_feedback VALUES (?, ?, ?, ?, ?, ?)",
               ("member-synthetic\x00surface-synthetic", "surface-synthetic", 1,
                "member-synthetic", "2026-01-01T00:00:00.000Z", "{}"))
    db.execute("INSERT INTO adminbot_paperflow_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               ("paper-synthetic", "accepted", "message-synthetic", "", None,
                "2026-01-01T00:00:00.000Z", "synthetic", 0.125))
    db.execute("INSERT INTO adminbot_openreview_cycles VALUES (?, ?, ?, ?, ?)",
               ("venue-synthetic", "abstract", 1900000000000,
                "2026-01-01T00:00:00.000Z", "{}"))
    db.execute("INSERT INTO adminbot_member_credentials VALUES (?, ?, ?, ?, ?)",
               ("member-synthetic", "person@example.invalid", "synthetic-scrypt-hash",
                "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"))
    db.execute("INSERT INTO adminbot_email_scan VALUES (1, ?)",
               ("2026-01-01T00:00:00.000Z",))
    db.execute("INSERT INTO adminbot_email_effects VALUES (?, ?, ?, ?, ?)",
               ("message-synthetic", "effect-synthetic", "done", None,
                "2026-01-01T00:00:00.000Z"))
    db.execute("INSERT INTO adminbot_onboarding_threads VALUES (?, ?, ?, ?, ?, ?)",
               ("thread-synthetic", "person@example.invalid", "approved", "message-synthetic",
                "complete", "2026-01-01T00:00:00.000Z"))
    db.execute("INSERT INTO adminbot_meeting_artifacts VALUES (?, ?, ?, ?, ?)",
               ("file-synthetic", "notes,\nquoted.txt", None, "ready",
                "2026-01-01T00:00:00.000Z"))
    db.execute("INSERT INTO adminbot_meeting_artifacts VALUES (?, ?, ?, ?, ?)",
               ("file-large", "before\rline\r\n" + "x" * 150000 + "\nafter", None, "ready",
                "2026-01-01T00:00:00.000Z"))
    db.commit()
    db.close()
    path.chmod(0o444)


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "snapshot.sqlite"
        fixture(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *args):
        return subprocess.run(["python3", str(SCRIPT), *args], cwd=APP,
                              capture_output=True, text=True)

    def test_plan_accepts_full_synthetic_schema(self):
        before = migrate.digest(self.path)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tables=54", result.stdout)
        self.assertNotIn("Ada", result.stdout)
        self.assertEqual(migrate.digest(self.path), before)
        self.assertFalse(Path(str(self.path) + "-shm").exists())

    def test_rejects_wal_sidecar_and_wrong_hash(self):
        sidecar = Path(str(self.path) + "-wal")
        sidecar.write_bytes(b"synthetic")
        refused = self.run_script("plan", "--sqlite", str(self.path))
        self.assertIn("WAL/SHM", refused.stderr)
        sidecar.unlink()
        refused = self.run_script(
            "apply", "--sqlite", str(self.path), "--source-sha256", "0" * 64,
            "--expected-tables", "54", "--schema", "adminbot_migration_wrong_hash",
        )
        self.assertIn("SHA-256 does not match", refused.stderr)

    def test_refuses_inline_copy_end_marker_before_opening_psql(self):
        other = Path(self.temp.name) / "malicious.sqlite"
        fixture(other)
        other.chmod(0o600)
        db = sqlite3.connect(other)
        db.execute("UPDATE adminbot_meeting_artifacts SET file_name=? WHERE file_id='file-synthetic'",
                   ("notes\n\\.\nDROP SCHEMA public CASCADE;\n",))
        db.commit()
        db.close()
        other.chmod(0o444)
        marker = Path(self.temp.name) / "psql-was-invoked"
        fake_psql = Path(self.temp.name) / "fake-psql"
        fake_psql.write_text("#!/bin/sh\ntouch '" + str(marker) + "'\n")
        fake_psql.chmod(0o755)
        refused = self.run_script(
            "apply", "--sqlite", str(other), "--source-sha256", migrate.digest(other),
            "--expected-tables", "54", "--schema", "adminbot_migration_attack",
            "--psql-command", str(fake_psql),
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("COPY end marker", refused.stderr)
        self.assertNotIn("DROP SCHEMA", refused.stderr)
        self.assertFalse(marker.exists())

    def test_refuses_writable_source_and_unknown_constraint(self):
        self.path.chmod(0o644)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("read-only", result.stderr)
        self.path.chmod(0o600)
        db = sqlite3.connect(self.path)
        db.execute("CREATE TABLE adminbot_extra (id TEXT PRIMARY KEY COLLATE NOCASE)")
        db.close()
        self.path.chmod(0o444)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collation/constraint", result.stderr)

    def test_rejects_null_pk(self):
        self.path.chmod(0o600)
        db = sqlite3.connect(self.path)
        db.execute("CREATE TABLE adminbot_extra (id TEXT PRIMARY KEY, note TEXT)")
        db.execute("INSERT INTO adminbot_extra VALUES (NULL, 'bad')")
        db.commit()
        db.close()
        self.path.chmod(0o444)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("null primary key", result.stderr)

    def test_rejects_blob(self):
        other = Path(self.temp.name) / "blob.sqlite"
        fixture(other)
        other.chmod(0o600)
        db = sqlite3.connect(other)
        db.execute("CREATE TABLE adminbot_extra (id TEXT PRIMARY KEY, note TEXT)")
        db.execute("INSERT INTO adminbot_extra VALUES ('extra', ?)", (b"blob",))
        db.commit()
        db.close()
        other.chmod(0o444)
        result = self.run_script("plan", "--sqlite", str(other))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported text", result.stderr)

    def test_rejects_unique_nocase_index(self):
        self.path.chmod(0o600)
        db = sqlite3.connect(self.path)
        db.execute("CREATE TABLE adminbot_extra (id TEXT PRIMARY KEY, nick TEXT)")
        db.execute("CREATE UNIQUE INDEX adminbot_extra_nick_idx ON adminbot_extra(nick COLLATE NOCASE)")
        db.commit()
        db.close()
        self.path.chmod(0o444)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unique NOCASE index needs manual review", result.stderr)

    def test_rejects_existing_duplicate_pending_registrations(self):
        self.path.chmod(0o600)
        db = sqlite3.connect(self.path)
        db.execute("DROP INDEX adminbot_pending_registrations_email_unique_idx")
        db.execute("DROP INDEX adminbot_pending_claims_member_unique_idx")
        rows = [
            ("one", "claim", "member-one", "same@example.invalid", "hash", "pending", "now"),
            ("two", "claim", "member-two", "SAME@example.invalid", "hash", "pending", "now"),
        ]
        db.executemany(
            "INSERT INTO adminbot_account_registrations "
            "(id, kind, member_id, email, password_scrypt, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)", rows,
        )
        db.commit()
        db.close()
        self.path.chmod(0o444)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate pending registration", result.stderr)
        self.path.chmod(0o600)
        db = sqlite3.connect(self.path)
        db.execute("UPDATE adminbot_account_registrations SET email = 'other@example.invalid', "
                   "member_id = 'member-one' WHERE id = 'two'")
        db.commit()
        db.close()
        self.path.chmod(0o444)
        result = self.run_script("plan", "--sqlite", str(self.path))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate pending registration", result.stderr)

    def test_post_commit_verification_failure_marks_schema_unverified(self):
        fake_psql = Path(self.temp.name) / "fake-psql"
        fake_psql.write_text(
            "#!/bin/sh\n"
            "for arg in \"$@\"; do [ \"$arg\" = '-c' ] && exit 0; done\n"
            "cat >/dev/null\n"
        )
        fake_psql.chmod(0o755)
        schema = "adminbot_migration_unverified_test"
        result = self.run_script(
            "apply", "--sqlite", str(self.path), "--source-sha256", migrate.digest(self.path),
            "--expected-tables", "54", "--schema", schema,
            "--psql-command", str(fake_psql),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PostgreSQL has fewer rows", result.stderr)
        self.assertIn("staging schema " + schema + " is UNVERIFIED", result.stderr)
        self.assertIn("do not promote", result.stderr)
        self.assertIn("clean it up manually", result.stderr)
        self.assertNotIn("Ada", result.stderr)

    def test_postgres_round_trip_if_configured(self):
        command = os.environ.get("ADMINBOT_TEST_PSQL_COMMAND")
        if not command:
            self.skipTest("set ADMINBOT_TEST_PSQL_COMMAND for isolated PostgreSQL")
        schema = "adminbot_migration_test_" + uuid.uuid4().hex[:12]
        def drop_test_schema():
            subprocess.run(
                shlex.split(command) + ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c",
                                        f"DROP SCHEMA IF EXISTS {schema} CASCADE"],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        self.addCleanup(drop_test_schema)
        source_hash = migrate.digest(self.path)
        result = self.run_script(
            "apply", "--sqlite", str(self.path), "--source-sha256", source_hash,
            "--expected-tables", "54", "--schema", schema, "--psql-command", command,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified exact row values in all 54 tables", result.stdout)
        self.assertNotIn("person@example.invalid", result.stdout)
        source_db = sqlite3.connect(f"file:{self.path}?mode=ro&immutable=1", uri=True)
        source_order = [row[0] for row in source_db.execute(
            "SELECT id FROM adminbot_lab_members "
            "ORDER BY json_extract(payload_json, '$.name') COLLATE NOCASE, id"
        )]
        source_db.close()
        self.assertEqual(source_order[0], "null-name")
        target_order = subprocess.run(
            shlex.split(command) + ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
                f"SELECT id FROM {schema}.adminbot_lab_members "
                "ORDER BY translate(payload_json::jsonb ->> 'name', "
                "'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE \"C\" "
                "NULLS FIRST, id"],
            capture_output=True, text=True, check=True,
        ).stdout.splitlines()
        self.assertEqual(target_order, source_order)
        def query(sql):
            return subprocess.run(
                shlex.split(command) + ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
                capture_output=True, text=True, check=True,
            ).stdout.strip()
        expiry_index = query(
            "SELECT indexname FROM pg_indexes WHERE schemaname = '" + schema + "' "
            "AND tablename = 'adminbot_sessions' "
            "AND indexname IN ('adminbot_sessions_expiry_lookup_idx', "
            "'adminbot_sessions_expiry_idx')"
        )
        self.assertIn(expiry_index, ("adminbot_sessions_expiry_lookup_idx", "adminbot_sessions_expiry_idx"))
        pending_indexes = query(
            "SELECT count(*) FROM pg_indexes WHERE schemaname = '" + schema + "' "
            "AND indexname IN ('adminbot_account_registrations_pending_email_idx', "
            "'adminbot_account_registrations_pending_member_idx')"
        )
        self.assertEqual(pending_indexes, "2")
        query(
            f"INSERT INTO {schema}.adminbot_lab_members "
            "(id, privilege_level, updated_at, payload_json) "
            "SELECT 'bulk-' || n, 'member', '2026-01-01T00:00:00.000Z', "
            "jsonb_build_object('name', CASE WHEN n % 97 = 0 THEN NULL "
            "ELSE lpad(n::text, 5, '0') END)::text "
            "FROM generate_series(1, 10000) AS n"
        )
        query(f"ANALYZE {schema}.adminbot_lab_members")
        plan = json.loads(query(
            "EXPLAIN (ANALYZE, FORMAT JSON) "
            f"SELECT id FROM {schema}.adminbot_lab_members "
            "ORDER BY translate(payload_json::jsonb ->> 'name', "
            "'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE \"C\" "
            "NULLS FIRST, id LIMIT 50"
        ))[0]["Plan"]
        self.assertEqual(plan["Node Type"], "Limit")
        self.assertEqual(plan["Plans"][0]["Node Type"], "Index Scan", json.dumps(plan))
        self.assertEqual(plan["Plans"][0]["Index Name"],
                         "adminbot_lab_members_name_nocase_idx")
        def scalar(sql):
            completed = subprocess.run(
                shlex.split(command) + ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
                capture_output=True, text=True, check=True,
            )
            return int(completed.stdout.strip())
        populated = scalar(
            f"INSERT INTO {schema}.adminbot_lab_members"
            " (id, privilege_level, updated_at, payload_json)"
            " VALUES ('new-member', 'member', '2026-01-02T00:00:00.000Z', '{}')"
            " RETURNING _sqlite_rowid"
        )
        empty = scalar(
            f"INSERT INTO {schema}.adminbot_director_broadcasts"
            " (id, posted_at, payload_json)"
            " VALUES ('new-broadcast', '2026-01-02T00:00:00.000Z', '{}')"
            " RETURNING _sqlite_rowid"
        )
        self.assertGreater(populated, 1)
        self.assertEqual(empty, 1)
        def rejected(sql):
            completed = subprocess.run(
                shlex.split(command) + ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
                capture_output=True, text=True,
            )
            self.assertNotEqual(completed.returncode, 0)
        rejected(
            f"INSERT INTO {schema}.adminbot_deadline_submission_keys VALUES"
            " ('member-synthetic', 'other-key', 'missing-proposal')"
        )
        rejected(
            f"INSERT INTO {schema}.adminbot_member_credentials VALUES"
            " ('other-member', 'person@example.invalid', 'hash', 'now', 'now')"
        )
        query(
            f"INSERT INTO {schema}.adminbot_account_registrations "
            "(id, kind, member_id, email, password_scrypt, status, created_at) VALUES "
            "('pending-one', 'claim', 'member-one', 'same@example.invalid', 'hash', 'pending', 'now')"
        )
        rejected(
            f"INSERT INTO {schema}.adminbot_account_registrations "
            "(id, kind, member_id, email, password_scrypt, status, created_at) VALUES "
            "('pending-two', 'claim', 'member-two', 'SAME@example.invalid', 'hash', 'pending', 'now')"
        )
        rejected(
            f"INSERT INTO {schema}.adminbot_account_registrations "
            "(id, kind, member_id, email, password_scrypt, status, created_at) VALUES "
            "('pending-three', 'claim', 'member-one', 'other@example.invalid', 'hash', 'pending', 'now')"
        )
        rejected(f"INSERT INTO {schema}.adminbot_director_status VALUES (2, '{{}}')")
        duplicate = self.run_script(
            "apply", "--sqlite", str(self.path), "--source-sha256", source_hash,
            "--expected-tables", "54", "--schema", schema, "--psql-command", command,
        )
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("transaction rolled back", duplicate.stderr)
        self.assertNotIn("UNVERIFIED", duplicate.stderr)
        self.assertNotIn("person@example.invalid", duplicate.stderr)


if __name__ == "__main__":
    unittest.main()
