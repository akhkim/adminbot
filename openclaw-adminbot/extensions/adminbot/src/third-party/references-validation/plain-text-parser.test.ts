import { describe, expect, it } from "vitest";
import { parseGeneric } from "./plain-text-parser.js";

describe("parseGeneric", () => {
  it("does not mistake an author list with middle initials for the title", () => {
    const parsed = parseGeneric(
      "[1] Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, and Illia Polosukhin. Attention is all you need. In Advances in Neural Information Processing Systems, 2017.",
    );
    expect(parsed.title).toBe("Attention is all you need");
    expect(parsed.authors).toContain("Illia Polosukhin");
  });

  it("handles leading and chained initials", () => {
    expect(
      parseGeneric(
        "[2] D. P. Kingma and J. Ba. Adam: A method for stochastic optimization. In International Conference on Learning Representations, 2015.",
      ).title,
    ).toBe("Adam: A method for stochastic optimization");
  });

  it("takes the sentence after the year as an ACL entry's title, not the venue", () => {
    expect(
      parseGeneric(
        "Jeffrey Pennington, Richard Socher, and Christopher D. Manning. 2014. Glove: Global vectors for word representation. In Empirical Methods in Natural Language Processing (EMNLP), pages 1532–1543.",
      ).title,
    ).toBe("Glove: Global vectors for word representation");
    expect(
      parseGeneric(
        "Jason Yosinski, Jeff Clune, Yoshua Bengio, and Hod Lipson. 2014. How transferable are features in deep neural networks? In Advances in neural information processing systems, pages 3320–3328.",
      ).title,
    ).toBe("How transferable are features in deep neural networks?");
  });

  it("does not take a page-range venue for the title in title-first entries", () => {
    expect(
      parseGeneric(
        "Tariq Alhindi, Tuhin Chakrabarty, Elena Musi, and Smaranda Muresan. Multitask instruction-based prompting for fallacy recognition. In Proceedings of the 2022 Conference on Empirical Methods in Natural Language Processing, pp. 8172–8187, Abu Dhabi, December 2022.",
      ).title,
    ).toBe("Multitask instruction-based prompting for fallacy recognition");
  });

  it("keeps parsing references without initials as before", () => {
    expect(
      parseGeneric(
        "[3] Kaiming He, Xiangyu Zhang, Shaoqing Ren, and Jian Sun. Deep residual learning for image recognition. In CVPR, 2016.",
      ).title,
    ).toBe("Deep residual learning for image recognition");
  });
});
