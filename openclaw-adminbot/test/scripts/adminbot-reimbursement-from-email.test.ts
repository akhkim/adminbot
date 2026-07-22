import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const helper = path.join(repoRoot, "scripts", "adminbot-reimbursement-from-email.py");
const formsDir = path.join(
  repoRoot,
  "extensions",
  "adminbot",
  "skills",
  "adminbot-reimbursements",
  "forms",
);
const temporaryDirectories: string[] = [];
const pythonEnv = { ...process.env, HOME: os.userInfo().homedir };

const sha256 = (file: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("AdminBot reimbursement form filler", () => {
  it("fills both canonical templates while preserving review-only fields and source files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-reimbursement-test-"));
    temporaryDirectories.push(directory);
    const input = path.join(directory, "reimbursement.json");
    const outputDirectory = path.join(directory, "forms");
    const workbookTemplate = path.join(formsDir, "Compute_Expense_Form.xlsx");
    const tripTemplate = path.join(formsDir, "Trip_Summary_Form.docx");
    const before = [sha256(workbookTemplate), sha256(tripTemplate)];
    fs.writeFileSync(
      input,
      JSON.stringify({
        claimant_name: "Alex Example",
        claimant_email: "alex@example.com",
        claimant_address: "123 College Street, Toronto, ON M5T 1P5",
        claimant_title: "Graduate Student",
        personnel_number: "10001234",
        travel_period: "2026-07-10 to 2026-07-14",
        purpose: "Attend and present research at the Example AI Conference.",
        currency: "CAD",
        other_currency: null,
        trip_title: "Example AI Conference 2026",
        trip_dates: "July 10-14, 2026",
        trip_location: "Montreal, Quebec, Canada",
        prepared_date: "2026-07-21",
        supporting_files: ["flight-receipt.pdf", "hotel-receipt.pdf", "taxi-receipt.png"],
        expenses: [
          {
            receipt_number: "1",
            date: "2026-07-10",
            description: "Economy flight to Montreal",
            category: "Airfare",
            amount: 1200,
            currency: "CAD",
            region: "canada",
            tax_region: "other_canada",
            airfare_class: "economy",
            includes_tip: false,
          },
          {
            receipt_number: "2",
            date: "2026-07-10",
            description: "Conference hotel",
            category: "Hotel",
            amount: 800,
            currency: "CAD",
            region: "canada",
            tax_region: "other_canada",
            airfare_class: null,
            includes_tip: false,
          },
          {
            receipt_number: "3",
            date: "2026-07-14",
            description: "Taxi from airport",
            category: "Taxi",
            amount: 50,
            currency: "CAD",
            region: "canada",
            tax_region: "ontario",
            airfare_class: null,
            includes_tip: true,
          },
        ],
      }),
    );

    const result = JSON.parse(
      execFileSync("python3", [helper, "fill", input, outputDirectory], {
        encoding: "utf8",
        env: { ...pythonEnv, ADMINBOT_REIMBURSEMENT_FORMS_DIR: formsDir },
      }),
    ) as { files: string[] };
    expect(result.files.map((file) => path.basename(file))).toEqual([
      "Compute_Expense_Form_Alex_Example.xlsx",
      "Trip_Summary_Form_Alex_Example.docx",
    ]);

    const inspection = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          [
            "import json, sys",
            "from docx import Document",
            "from openpyxl import load_workbook",
            "wb = load_workbook(sys.argv[1], data_only=False)",
            "main = wb['Reimbursement Form']",
            "summary = wb['Expense Summary']",
            "doc = Document(sys.argv[2])",
            "print(json.dumps({'main': {c: main[c].value for c in ['I4','A12','A28','L11','L19','L36','L47','L48','L49','M50']}, 'summary': {c: summary[c].value for c in ['B4','D4','E4','K5','T6','D36']}, 'paragraphs': {str(i): doc.paragraphs[i].text for i in [1,5,6,7,10,23,24,25]}, 'table': [[cell.text for cell in row.cells] for row in doc.tables[0].rows]}, default=str))",
          ].join("; "),
          result.files[0],
          result.files[1],
        ],
        { encoding: "utf8", env: pythonEnv },
      ),
    ) as {
      main: Record<string, unknown>;
      summary: Record<string, unknown>;
      paragraphs: Record<string, string>;
      table: string[][];
    };

    expect(inspection.main).toMatchObject({
      I4: "X",
      A12: "Alex Example",
      L11: 1200,
      L19: 800,
      L36: 50,
      L47: "=SUM(L11:L46)",
      L48: null,
      L49: "X",
      M50: "Funding Source: ",
    });
    expect(inspection.summary).toMatchObject({
      B4: "1",
      D4: "Economy flight to Montreal",
      E4: 1200,
      K5: 800,
      T6: 50,
      D36: "=SUM(E34:AD34)",
    });
    expect(inspection.paragraphs).toMatchObject({
      "1": "Example AI Conference 2026",
      "5": "",
      "6": "",
      "7": "",
      "10": "Alex Example",
      "23": "flight-receipt.pdf",
      "24": "hotel-receipt.pdf",
      "25": "taxi-receipt.png",
    });
    expect(inspection.table.at(-1)).toEqual(["TOTAL", "CAD 2050.00"]);
    expect([sha256(workbookTemplate), sha256(tripTemplate)]).toEqual(before);
  });
});
