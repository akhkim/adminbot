// Round face photos for the working-groups slide.
//
// The faces on the slide are round, but the Slides API cannot apply the editor's "mask image"
// shape, and an outline on a square image draws a square. So the circle -- and the ring around it,
// when the slide's faces have one -- is baked into a PNG with transparent corners before Slides
// ever sees it. Rastermill (already the root image library) normalises whatever the avatar is to
// a square RGBA PNG; the few lines of PNG reading below are only ever fed that output.

import { inflateSync } from "node:zlib";
import { createRastermill, encodePngRgba } from "rastermill";
import type { FaceRing } from "../contracts/google-slides.js";

/** Pixels across the rendered face: a 0.55 in face at 300 dpi is ~165 px, so this is sharp. */
export const FACE_PNG_SIZE = 256;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

export type RgbaImage = { width: number; height: number; pixels: Uint8Array };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/**
 * Reads an 8-bit, non-interlaced greyscale, RGB or RGBA PNG -- what Rastermill writes -- into RGBA.
 * Anything else is refused rather than half-decoded.
 */
export function decodePng(png: Uint8Array): RgbaImage {
  const buffer = Buffer.from(png);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let colorType = -1;
  const data: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      colorType = body[9]!;
      if (bitDepth !== 8 || body[12] !== 0 || ![0, 2, 4, 6].includes(colorType)) {
        throw new Error("unsupported PNG layout (want 8-bit, non-interlaced grey/RGB/RGBA)");
      }
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height) {
    throw new Error("PNG has no IHDR");
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < height * (stride + 1)) {
    throw new Error("PNG image data is truncated");
  }
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]!;
      const left = x >= channels ? rows[target + x - channels]! : 0;
      const up = y > 0 ? rows[target - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? rows[target - stride + x - channels]! : 0;
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upLeft)
                  : -1;
      if (predicted < 0) {
        throw new Error(`unknown PNG filter ${filter}`);
      }
      rows[target + x] = (value + predicted) & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const at = index * channels;
    const grey = channels <= 2;
    pixels[index * 4] = rows[at]!;
    pixels[index * 4 + 1] = grey ? rows[at]! : rows[at + 1]!;
    pixels[index * 4 + 2] = grey ? rows[at]! : rows[at + 2]!;
    pixels[index * 4 + 3] = channels === 4 ? rows[at + 3]! : channels === 2 ? rows[at + 1]! : 255;
  }
  return { width, height, pixels };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Cuts a square image into a circle with transparent corners, with the slide's ring drawn on the
 * inside of the edge. Edges are anti-aliased by pixel coverage so the circle does not look
 * stair-stepped when projected.
 */
export function maskRoundFace(image: RgbaImage, ring: FaceRing | null): Uint8Array {
  const { width, height, pixels } = image;
  const size = Math.min(width, height);
  const radius = size / 2;
  const cx = width / 2;
  const cy = height / 2;
  const ringWidth = ring ? Math.max(1, ring.width_ratio * size) : 0;
  const ringRgb = ring ? [ring.red, ring.green, ring.blue].map((value) => Math.round(clamp01(value) * 255)) : [];
  const out = new Uint8Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp01(radius - distance + 0.5);
      const at = (y * width + x) * 4;
      if (ring) {
        const inRing = clamp01(distance - (radius - ringWidth) + 0.5);
        for (let channel = 0; channel < 3; channel += 1) {
          out[at + channel] = Math.round(out[at + channel]! * (1 - inRing) + ringRgb[channel]! * inRing);
        }
        if (inRing > 0) {
          out[at + 3] = Math.round(out[at + 3]! * (1 - inRing) + 255 * inRing);
        }
      }
      out[at + 3] = Math.round(out[at + 3]! * coverage);
    }
  }
  return out;
}

export type RoundFaceRenderer = (avatar: Uint8Array, ring: FaceRing | null) => Promise<Buffer>;

/** Any image Rastermill reads -> a square, centre-cropped, round PNG with transparent corners. */
export function createRoundFaceRenderer(size = FACE_PNG_SIZE): RoundFaceRenderer {
  const rastermill = createRastermill();
  return async (avatar, ring) => {
    const square = await rastermill.encode(avatar, {
      format: "png",
      resize: { fit: "cover", width: size, height: size },
    });
    const image = decodePng(square.data);
    return encodePngRgba(maskRoundFace(image, ring), image.width, image.height);
  };
}

/** Downloads an avatar, https only and size-capped: the URL comes from a member's profile. */
export async function fetchAvatar(url: string, doFetch: typeof fetch = fetch): Promise<Uint8Array> {
  if (!/^https:\/\//u.test(url)) {
    throw new Error("avatar URL is not https");
  }
  const response = await doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`avatar download failed (${response.status})`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    throw new Error("avatar is larger than 8 MB");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error("avatar is larger than 8 MB");
  }
  return bytes;
}
