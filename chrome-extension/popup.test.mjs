import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const source = await readFile(new URL("./popup.js", import.meta.url), "utf8");
async function popup() {
  let submit;
  const input = { value: "" }, status = { textContent: "" }, opened = [], saved = [];
  await runInNewContext(`(async () => { ${source} })()`, {
    URL,
    document: { querySelector: (selector) => selector === "#url" ? input : selector === "#status" ? status : {
      addEventListener: (_, handler) => { submit = handler; },
    } },
    chrome: {
      storage: { local: { get: async () => ({}), set: async (value) => saved.push(value.portalUrl) } },
      tabs: { create: async (value) => opened.push(value.url) },
    },
    window: { close() {} },
  });
  return { input, status, opened, saved, submit: () => submit({ preventDefault() {} }) };
}
test("opens the prepared HTTPS workspace without fetching records", async () => {
  const ui = await popup();
  ui.input.value = "https://portal.example/lab/";
  await ui.submit();
  assert.deepEqual(ui.opened, [ui.input.value]);
  assert.deepEqual(ui.saved, [ui.input.value]);
});
test("refuses credentials, tokens and unsafe URL schemes", async () => {
  for (const value of ["javascript:alert(1)", "http://public.example/", "https://user:secret@portal.example/", "https://portal.example/?token=secret", "https://portal.example/#token"]) {
    const ui = await popup();
    ui.input.value = value;
    await ui.submit();
    assert.equal(ui.opened.length, 0);
    assert.equal(ui.saved.length, 0);
    assert.match(ui.status.textContent, /HTTPS/);
  }
});
test("allows a local development portal", async () => {
  const ui = await popup();
  ui.input.value = "http://127.0.0.1:5173/";
  await ui.submit();
  assert.deepEqual(ui.opened, [ui.input.value]);
});
