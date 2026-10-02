export type ReferenceFinding = {
  citation: string;
  status: "fake" | "exist_with_issues";
  explanation: string;
};

export type ReferenceScanResult = {
  provider_scan_id: string;
  response_version: number;
  citation_count: number;
  uncertain_count: number;
  findings: ReferenceFinding[];
};

export type ReferenceScan = {
  submission_id: string;
  pdf_sha256: string;
  status: "running" | "completed" | "failed";
  result?: ReferenceScanResult;
};

export type ReferenceScanStore = {
  getReferenceScan(submissionId: string, pdfHash: string): ReferenceScan | undefined;
  saveReferenceScan(scan: ReferenceScan): void;
};

export type PublicOpenReviewPdf = {
  submission_id: string;
  title: string;
  bytes: Uint8Array;
};

export type ReferenceScanDependencies = {
  readPdf: (submissionId: string) => Promise<PublicOpenReviewPdf>;
  scanPdf?: (bytes: Uint8Array) => Promise<ReferenceScanResult>;
};
