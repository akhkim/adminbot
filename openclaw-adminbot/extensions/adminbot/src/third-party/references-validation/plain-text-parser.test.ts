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

  it("keeps parsing references without initials as before", () => {
    expect(
      parseGeneric(
        "[3] Kaiming He, Xiangyu Zhang, Shaoqing Ren, and Jian Sun. Deep residual learning for image recognition. In CVPR, 2016.",
      ).title,
    ).toBe("Deep residual learning for image recognition");
  });
});
