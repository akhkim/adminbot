// Shapes taken from real conference PDFs as PDFium extracts them (\r\n line ends, U+FFFE at
// hyphenated breaks); the names and titles are published works, not lab manuscripts.
import { describe, expect, it } from "vitest";
import { findReferencesSection, splitIntoReferences } from "./pdf-extract-service.js";

const acl = [
  "Alan Akbik, Duncan Blythe, and Roland Vollgraf.",
  "2018. Contextual string embeddings for sequence",
  "labeling. In Proceedings of the 27th International",
  "Conference on Computational Linguistics, pages",
  "1638–1649.",
  "Luisa Bentivogli, Bernardo Magnini, Ido Dagan,",
  "Hoa Trang Dang, and Danilo Giampiccolo. 2009.",
  "The fifth PASCAL recognizing textual entailment",
  "challenge. In TAC. NIST.",
  "Samuel R. Bowman, Gabor Angeli, Christopher Potts,",
  "and Christopher D. Manning. 2015. A large anno￾tated corpus for learning natural language inference.",
  "In EMNLP. Association for Computational Linguistics.",
  "Rami Al-Rfou, Dokook Choe, Noah Constant, Mandy",
  "Guo, and Llion Jones. 2018. Character-level lan￾guage modeling with deeper self-attention. arXiv",
  "preprint arXiv:1808.04444.",
].join("\r\n");

describe("splitIntoReferences", () => {
  it("splits an ACL author-year bibliography without splitting venues or titles", () => {
    const refs = splitIntoReferences(acl);
    expect(refs).toHaveLength(4);
    expect(refs[1]).toBe(
      "Luisa Bentivogli, Bernardo Magnini, Ido Dagan, Hoa Trang Dang, and Danilo Giampiccolo. 2009. The fifth PASCAL recognizing textual entailment challenge. In TAC. NIST.",
    );
    expect(refs[2]).toContain("annotated corpus");
    expect(refs[2]).toContain("In EMNLP. Association for Computational Linguistics.");
  });

  it("splits initials-first entries that end in their year", () => {
    const refs = splitIntoReferences(
      [
        "M. G. Bellemare, Y. Naddaf, J. Veness, and M. Bowling. The arcade learning environment: An",
        "evaluation platform for general agents. J. Artif. Intell. Res., 47:253–279, 2013.",
        "Y. Bisk, R. Zellers, R. L. Bras, J. Gao, and Y. Choi. Piqa: Reasoning about physical commonsense",
        "in natural language. In AAAI, 2020.",
        "T. B. Brown, B. Mann, N. Ryder, M. Subbiah, J. Kaplan, P. Dhariwal, A. Neelakantan, P. Shyam,",
        "G. Sastry, A. Askell, et al. Language models are few-shot learners. arXiv preprint, 2020.",
      ].join("\n"),
    );
    expect(refs).toHaveLength(3);
    expect(refs[2]).toMatch(/^T\. B\. Brown.*few-shot learners/);
  });

  it("treats ICLR back-references to citing pages as the end of an entry", () => {
    const refs = splitIntoReferences(
      [
        "Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT: Pre-training of deep",
        "bidirectional transformers for language understanding. In NAACL, pp. 4171–4186, June 2019. 1, 6",
        "Clark Glymour, Kun Zhang, and Peter Spirtes. Review of causal discovery methods based on graphical",
        "models. Frontiers in Genetics, 10:524, 2019. 3",
        "Judea Pearl, Madelyn Glymour, and Nicholas P. Jewell. Causal inference in statistics: A primer.",
        "John Wiley & Sons, 2016. 2",
      ].join("\n"),
    );
    expect(refs).toHaveLength(3);
  });

  it("keeps a twenty-author list in one entry and still splits after it", () => {
    const authors = Array.from(
      { length: 24 },
      (_, i) => `Author${"abcdefghijklmnopqrstuvwxyz"[i]} Person`,
    );
    const lines = ["Ciprian Chelba and Tomas Mikolov. 2013. One billion word benchmark. arXiv."];
    for (let i = 0; i < authors.length; i += 3) {
      lines.push(authors.slice(i, i + 3).join(", ") + ",");
    }
    lines.push("and Wojciech Zaremba. 2021. Evaluating large language models trained on code.");
    lines.push(
      "Aakanksha Chowdhery and Sharan Narang. 2022. Palm: Scaling language modeling. arXiv.",
    );
    const refs = splitIntoReferences(lines.join("\n"));
    expect(refs).toHaveLength(3);
    expect(refs[1]).toMatch(/^Authora Person.*Evaluating large language models trained on code\.$/);
  });

  it("does not end an entry at a wrapped author initial", () => {
    const refs = splitIntoReferences(
      [
        "Mark Chen and Jerry Tworek. 2021. Evaluating large language models trained on code. arXiv.",
        "Aakanksha Chowdhery, Sharan Narang, Jacob Devlin, Andrew N.",
        "Carr, Jan Leike, and Josh Achiam. 2022. Palm: Scaling language modeling. arXiv.",
      ].join("\n"),
    );
    expect(refs).toHaveLength(2);
  });

  it("splits alphabetic labels, including wrapped and run-together ones", () => {
    const refs = splitIntoReferences(
      [
        "[AI23] Meta AI. Introducing meta llama 3, 2023.",
        "[BZGC19] Yonatan Bisk, Rowan Zellers, Jianfeng Gao, and Yejin Choi. Piqa: Reasoning about physical",
        "commonsense in natural language. arXiv preprint arXiv:1911.11641, 2019. [CCE+",
        "18] Peter Clark, Isaac Cowhey, and Oren Etzioni. Think you have solved question answering? 2018.",
      ].join("\n"),
    );
    expect(refs.map((ref) => ref.slice(0, 8))).toEqual(["[AI23] M", "[BZGC19]", "[CCE+ 18"]);
  });

  it("stays in author-year mode when an appendix list is numbered", () => {
    const refs = splitIntoReferences(
      [acl, "1. For all authors...", "2. If you are including theoretical results..."].join("\n"),
    );
    expect(refs[0]).toMatch(/^Alan Akbik/);
    expect(refs.length).toBeLessThanOrEqual(5);
  });

  it("cuts appendix prose off the last entry, keeping its authors and title", () => {
    const entries = Array.from(
      { length: 6 },
      (_, i) =>
        `[${i + 1}] Author ${i} and Other Person. A paper about topic ${i}. In Venue, 2020.`,
    );
    const prose =
      " Attention Visualizations It is in this spirit that a majority of American governments have passed new laws.".repeat(
        20,
      );
    const refs = splitIntoReferences([...entries.slice(0, -1), entries.at(-1) + prose].join("\n"));
    expect(refs).toHaveLength(6);
    // Lookups search by title, which comes early; the prose is what must go.
    expect(refs.at(-1)).toMatch(/^\[6\] Author 5 and Other Person\. A paper about topic 5\./);
    expect(refs.at(-1)).not.toContain("Attention Visualizations");
  });
});

describe("findReferencesSection", () => {
  const bibliography = Array.from(
    { length: 12 },
    (_, i) =>
      `Author${"abcdefghijkl"[i]} Person and Other Person. 2020. Title number ${i}. In Venue.`,
  );

  it("ends at a lettered appendix heading", () => {
    const text = [
      "References",
      ...bibliography,
      "A Additional Settings and Results",
      "Details of victim models. For DialoGPT, we use the small model.",
    ].join("\n");
    const section = findReferencesSection(text);
    expect(section.sectionText).not.toContain("Additional Settings");
    expect(section.sectionText).toContain("Title number 11");
  });

  it("does not end at a wrapped reference title that looks like a heading", () => {
    const text = [
      "References",
      ...bibliography.slice(0, 11),
      "Wayne Xin Zhao, Kun Zhou, and Junyi Li. 2023.",
      "A Survey of Large Language Models for Code",
      ...bibliography.map((line) => line.replace("Title", "Later")),
    ].join("\n");
    expect(findReferencesSection(text).sectionText).toContain("Later number 11");
  });

  it("ends at a responsible-NLP checklist", () => {
    const text = [
      "References",
      ...bibliography,
      "ACL 2023 Responsible NLP Checklist",
      "A For every submission:",
    ].join("\n");
    expect(findReferencesSection(text).sectionText).not.toContain("For every submission");
  });
});
