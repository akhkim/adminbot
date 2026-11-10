import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGeneric } from "../third-party/references-validation/plain-text-parser.js";
import {
  citedBibReferences,
  citedKeys,
  parseBib,
  plainTex,
  renderCitation,
} from "./bib-references.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function paper(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-bib-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const BIB = String.raw`
@string{neurips = "Advances in Neural Information Processing Systems"}
@comment{ an aside with an @article{fake, title={Not real}} inside }
@inproceedings{synthetic2017garden,
  title     = {Attention to {Synthetic} Gardens},
  author    = {Vaswani, Ada and Shazeer, Ben and Others},
  booktitle = neurips # " 30",
  year      = 2017,
}
@article{lovelace2020,
  title   = "A Study of M{\"u}ller's Method",
  author  = {Ada Lovelace},
  journal = {Journal of Synthetic Results},
  year    = {2020},
  doi     = {10.1234/synthetic.5678},
}
@misc{uncited2021,
  title  = {Never Cited},
  author = {Nobody, Nemo},
  year   = {2021},
}
@misc{preprint2023,
  title         = {Synthetic Preprints},
  author        = {Turing, Alan},
  year          = {2023},
  eprint        = {2301.00001},
  archivePrefix = {arXiv},
}
@misc{notitle,
  author = {Someone},
}
`;

describe("citedBibReferences", () => {
  it("renders only the entries the paper cites, in first-cited order", () => {
    const dir = paper({
      "main.tex": String.raw`\documentclass{article}
\begin{document}
As shown by \citet{lovelace2020} and \citep[p.~3]{synthetic2017garden, LOVELACE2020}.
% \cite{uncited2021} is commented out
\input{sections/intro}
\bibliography{refs}
\end{document}`,
      "sections/intro.tex": String.raw`See \parencite{preprint2023}, \cite{missing-key} and \cite{notitle}.`,
      "refs.bib": BIB,
      // papermentor's own output is never read as part of the paper.
      "papermentor/backup/old.tex": String.raw`\cite{uncited2021}`,
    });
    const result = citedBibReferences(dir)!;
    expect(result.cited).toBe(5);
    expect(result.skipped).toBe(2);
    expect(result.references).toEqual([
      "Ada Lovelace. 2020. A Study of Muller's Method. Journal of Synthetic Results. DOI: 10.1234/synthetic.5678",
      "Ada Vaswani and Ben Shazeer. 2017. Attention to Synthetic Gardens. In Advances in Neural Information Processing Systems 30.",
      "Alan Turing. 2023. Synthetic Preprints. arXiv preprint arXiv:2301.00001.",
    ]);
  });

  it("checks every entry with \\nocite{*}", () => {
    const dir = paper({ "main.tex": String.raw`\nocite{*}`, "refs.bib": BIB });
    expect(citedBibReferences(dir)!.references).toHaveLength(4);
  });

  it("is nothing to read from without a .bib, or when no cited key resolves", () => {
    expect(citedBibReferences(paper({ "main.tex": String.raw`\cite{x}` }))).toBeUndefined();
    expect(
      citedBibReferences(paper({ "main.tex": String.raw`\cite{x}`, "refs.bib": BIB })),
    ).toBeUndefined();
  });
});

describe("rendered citations", () => {
  it("read back through the lookup's parser with the right title and authors", () => {
    const entry = parseBib(BIB).find((e) => e.key === "synthetic2017garden");
    const parsed = parseGeneric(renderCitation(entry!)!);
    expect(parsed.title).toBe("Attention to Synthetic Gardens");
    expect(parsed.authors).toBe("Ada Vaswani and Ben Shazeer");
    expect(parsed.year).toBe("2017");
  });

  it("keep a long author list short and never put digits among the names", () => {
    const authors = Array.from({ length: 12 }, (_, i) => `Author${i}, A.`).join(" and ");
    const citation = renderCitation({
      type: "article",
      key: "k",
      fields: { title: "Big Team", author: authors, year: "2024" },
    })!;
    expect(citation).toBe("A. Author, A. Author, A. Author, et al. 2024. Big Team.");
  });
});

describe("the small pieces", () => {
  it("strips TeX from a field", () => {
    expect(plainTex(String.raw`\emph{Deep} {L}earning for \textsc{NLP} \& M{\'e}tis -- ~2`)).toBe(
      "Deep Learning for NLP & Metis – 2",
    );
  });

  it("finds cite keys in the commands biblatex and natbib use, ignoring comments", () => {
    expect(
      citedKeys([
        String.raw`\autocite{a} \textcite[see][12]{b,c} \citeauthor*{d} 50\% done % \cite{e}`,
      ]),
    ).toEqual({ keys: ["a", "b", "c", "d"], all: false });
  });

  it("does not trip over malformed entries", () => {
    expect(parseBib("@article{broken, title = {unclosed")).toEqual([
      { type: "article", key: "broken", fields: {} },
    ]);
    expect(parseBib("@@@ not bib at all {}")).toEqual([]);
  });
});
