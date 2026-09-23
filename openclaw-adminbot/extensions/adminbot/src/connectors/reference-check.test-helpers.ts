/** Small real text PDF for extraction tests, without checking a manuscript into the repository. */
export function referencePdf(lines: string[]): Uint8Array {
  return referencePdfPages([lines]);
}

/** One page per entry of `pages`, each a list of text lines. */
export function referencePdfPages(pages: string[][]): Uint8Array {
  const pageCount = pages.length;
  // Object numbers: 1 catalog, 2 page tree, 3 font, then a page and its content stream per page.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    const escaped = lines.map((line) => line.replace(/([\\()])/g, "\\$1"));
    const stream = `BT /F1 10 Tf 50 750 Td 14 TL ${escaped.map((line, j) => `${j ? "T* " : ""}(${line}) Tj`).join("\n")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
