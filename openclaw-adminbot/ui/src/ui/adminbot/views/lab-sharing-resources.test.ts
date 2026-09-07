import { render } from "lit";
import { expect, it } from "vitest";
import { tabFromPath } from "../../navigation.ts";
import { renderLabSharingResources } from "./lab-sharing-resources.ts";

it("keeps resource destinations inside a mounted portal and hides them on logout", () => {
  const root = document.createElement("div");
  render(renderLabSharingResources("/portal/", true), root);
  const links = [...root.querySelectorAll("a")];
  expect(links).toHaveLength(4);
  for (const link of links) {
    const path = link.getAttribute("href")!;
    expect(path.startsWith("/portal/")).toBe(true);
    expect(tabFromPath(path, "/portal")).not.toBeNull();
  }
  render(renderLabSharingResources("/portal", false), root);
  expect(root.querySelector("a")).toBeNull();
});
