// The MPI IS PDF filler, run against the real bundled template.
//
// Worth running for real rather than mocking: every bug this script has had came from the
// template's own shape — indirect AcroForm objects, /Sig widgets that lock the document, and
// values that live in widget appearance streams rather than page content. None of those show up
// against a stub.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO, "scripts/adminbot_mpi_reimbursement.py");

const DRAFT = {
  claimant: {
    name: "Ada Lovelace",
    address_line1: "12 Privatstrasse",
    zip_city: "72076 Tübingen",
    country: "Germany",
    email: "ada@example.org",
  },
  bank: {
    account_holder: "Ada Lovelace",
    bank_name: "Beispielbank",
    iban: "DE89370400440532013000",
    swift: "COBADEFFXXX",
  },
  trip: {
    reason: "trip to Budapest to present Causal abstraction at EMNLP 2026",
    responsible_person: "Zhijing Jin",
    stay_from: "04.11.26",
    stay_to: "09.11.26",
    travel_from: "Tübingen",
    travel_to: "Budapest",
  },
  costs: {
    flight: { label: "Flight STR-BUD return", amount: 312.4, eur: 312.4 },
    hotel: { label: "Hotel Danubius 5 nights", amount: 648, eur: 648 },
    other_1: { label: "EMNLP registration", amount: 650, eur: 598.12 },
  },
  total_eur: 1558.52,
};

let dir = "";
let result: { files: string[]; fields_written: number; unknown_fields: string[] };
let available = true;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "adminbot-mpi-"));
  const input = path.join(dir, "draft.json");
  await writeFile(input, JSON.stringify(DRAFT), "utf8");
  try {
    const run = await execFileAsync("python3", [SCRIPT, "fill", input, dir], {
      maxBuffer: 8 * 1024 * 1024,
    });
    result = JSON.parse(run.stdout);
  } catch (error) {
    // pypdf is an optional host dependency (scripts/adminbot-reimbursement-requirements.txt).
    // Skipping is honest where it is absent; asserting would fail the suite on the library rather
    // than on this script.
    available = false;
    if (!String(error).includes("ModuleNotFoundError")) {
      throw error;
    }
  }
}, 60_000);

afterAll(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the MPI IS reimbursement form", () => {
  it("writes both files and recognises every field it maps", () => {
    if (!available) {
      return;
    }
    expect(result.files).toHaveLength(2);
    expect(result.fields_written).toBeGreaterThan(20);
    // A mapping that has drifted from the template silently leaves boxes empty; this is the only
    // place that would show.
    expect(result.unknown_fields).toEqual([]);
  });

  it("keeps every filled value in the signable copy", async () => {
    if (!available) {
      return;
    }
    const [live, toSign] = result.files;
    // Both files are real PDFs carrying the values. Checked by byte-probing the appearance
    // streams rather than parsing: the point is that the text survived into the second file,
    // which is the bug that shipped once already.
    for (const file of [live, toSign]) {
      const bytes = await readFile(file as string);
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(10_000);
    }
    const signable = await readFile(toSign as string, "latin1");
    expect(signable).toContain("Ada Lovelace");
    expect(signable).toContain("1558.52");
  });

  it("strips the signature widgets that stop a claimant signing at all", async () => {
    if (!available) {
      return;
    }
    const [live, toSign] = result.files;
    const original = await readFile(live as string, "latin1");
    const signable = await readFile(toSign as string, "latin1");
    // The live copy keeps them for Acrobat and for the record; the signable copy does not, which
    // is the whole reason two files ship.
    expect(original).toContain("/Sig");
    expect(signable).not.toContain("/SigFlags");
  });
});
