import { deflateSync } from "node:zlib";
import { encodePngRgba } from "rastermill";
import { describe, expect, it } from "vitest";
import { createRoundFaceRenderer, decodePng, fetchAvatar, maskRoundFace } from "./slides-face-image.js";

function gradient(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set([(index * 7) % 256, 100, (index * 3) % 256, 255], index * 4);
  }
  return pixels;
}

const alphaAt = (image: { width: number; pixels: Uint8Array }, x: number, y: number) =>
  image.pixels[(y * image.width + x) * 4 + 3];

describe("decodePng", () => {
  it("round-trips what Rastermill encodes", () => {
    const pixels = gradient(40, 30);
    const image = decodePng(encodePngRgba(pixels, 40, 30));
    expect([image.width, image.height]).toEqual([40, 30]);
    expect(Buffer.from(image.pixels).equals(Buffer.from(pixels))).toBe(true);
  });

  it("refuses non-PNG input and layouts it does not read", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/u);
    const png = Buffer.from(encodePngRgba(gradient(2, 2), 2, 2));
    png[8 + 8 + 8] = 16; // IHDR bit depth -> 16
    expect(() => decodePng(png)).toThrow(/unsupported PNG layout/u);
  });

  it("reads RGB PNGs with every filter type", () => {
    const width = 3;
    const rows: number[] = [];
    for (let filter = 0; filter <= 4; filter += 1) {
      rows.push(filter, ...Array.from({ length: width * 3 }, () => 0));
    }
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(5, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.from(rows))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const image = decodePng(png);
    expect(image.pixels.every((value, index) => value === (index % 4 === 3 ? 255 : 0))).toBe(true);
  });
});

describe("round faces", () => {
  it("makes the corners transparent and keeps the middle opaque", () => {
    const pixels = maskRoundFace({ width: 64, height: 64, pixels: gradient(64, 64) }, null);
    const image = { width: 64, pixels };
    expect(alphaAt(image, 0, 0)).toBe(0);
    expect(alphaAt(image, 63, 63)).toBe(0);
    expect(alphaAt(image, 32, 32)).toBe(255);
    expect(alphaAt(image, 32, 0)).toBeGreaterThan(0);
  });

  it("paints the measured ring just inside the edge", () => {
    const ring = { red: 1, green: 1, blue: 1, width_ratio: 0.06 };
    const pixels = maskRoundFace({ width: 64, height: 64, pixels: gradient(64, 64) }, ring);
    const at = (32 * 64 + 1) * 4;
    expect(Array.from(pixels.slice(at, at + 4))).toEqual([255, 255, 255, 255]);
    const centre = (32 * 64 + 32) * 4;
    expect(pixels[centre + 1]).toBe(100);
  });

  it("crops any avatar to a square round PNG", async () => {
    const render = createRoundFaceRenderer(48);
    const avatar = encodePngRgba(gradient(80, 50), 80, 50);
    const image = decodePng(await render(avatar, null));
    expect([image.width, image.height]).toEqual([48, 48]);
    expect(alphaAt(image, 0, 0)).toBe(0);
    expect(alphaAt(image, 24, 24)).toBe(255);
  });
});

describe("fetchAvatar", () => {
  it("only fetches https and refuses oversized images", async () => {
    await expect(fetchAvatar("http://example.test/a.png")).rejects.toThrow(/https/u);
    const big = (async () =>
      new Response("x", { headers: { "content-length": String(9 * 1024 * 1024) } })) as typeof fetch;
    await expect(fetchAvatar("https://example.test/a.png", big)).rejects.toThrow(/8 MB/u);
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
    expect(Array.from(await fetchAvatar("https://example.test/a.png", ok))).toEqual([1, 2, 3]);
  });
});
