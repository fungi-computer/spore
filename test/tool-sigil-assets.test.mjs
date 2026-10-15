// Exercise the built distribution and its generated PNG artifact together.
import { expect, test } from "bun:test";
import { z } from "zod";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { generateToolSigilImages } from "../scripts/build-tool-sigils.mjs";
import { loadToolSigils, deleteToolSigils } from "../dist/tool-sigils.js";

test("build-generated PNGs use seven stable virtual placements and bounded uploads", async () => {
  const writes = [];
  const glyphs = await loadToolSigils((data) => writes.push(data));
  expect(Object.keys(glyphs).sort()).toEqual([
    "code",
    "command",
    "edit",
    "error",
    "other",
    "read",
    "search",
  ]);
  const placements = writes.filter((data) => data.includes("a=p,"));
  expect(placements).toEqual(
    [61441, 61442, 61443, 61444, 61445, 61446, 61447].map(
      (id) => `\u001b_Ga=p,i=${String(id)},U=1,c=3,r=1,q=2;\u001b\\`,
    ),
  );
  const uploads = writes.filter((data) => data.includes("a=t,"));
  expect(uploads).toHaveLength(7);
  for (const command of uploads) {
    expect(command).toContain("f=100,");
    expect(command).toContain("q=2,");
    expect(command.split(";")[1]?.length).toBeLessThanOrEqual(4_098);
  }
  const assets = z
    .strictObject({
      cellWidth: z.number().int().positive(),
      cellHeight: z.number().int().positive(),
      images: z.record(z.string(), z.tuple([z.base64(), z.base64()])),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../dist/tool-sigil-images.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  for (const pair of Object.values(assets.images)) {
    for (const [index, encoded] of pair.entries()) {
      const png = Buffer.from(encoded, "base64");
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(png.readUInt32BE(16)).toBe(assets.cellWidth * 3 * (index + 1));
      expect(png.readUInt32BE(20)).toBe(assets.cellHeight * (index + 1));
    }
  }
  const released = [];
  deleteToolSigils((data) => released.push(data));
  expect(released).toEqual(
    [61441, 61442, 61443, 61444, 61445, 61446, 61447].map(
      (id) => `\u001b_Ga=d,d=I,i=${String(id)},q=2;\u001b\\`,
    ),
  );
});

test("checked-in default tool sigil artwork is fresh", async () => {
  const source = JSON.parse(
    await readFile(
      new URL("../src/tool-sigil-images.json", import.meta.url),
      "utf8",
    ),
  );
  const generated = await generateToolSigilImages();
  expect(generated.cellWidth).toBe(source.cellWidth);
  expect(generated.cellHeight).toBe(source.cellHeight);
  expect(Object.keys(generated.images).sort()).toEqual(
    Object.keys(source.images).sort(),
  );
  for (const [name, pair] of Object.entries(generated.images)) {
    expect(source.images[name]).toHaveLength(pair.length);
    for (const [index, encoded] of pair.entries()) {
      // PNG compression can differ across hosts; dimensions and RGBA pixels
      // are the artwork contract, rather than the encoded container bytes.
      const [actual, expected] = await Promise.all(
        [encoded, source.images[name][index]].map((image) =>
          sharp(Buffer.from(image, "base64"))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true }),
        ),
      );
      expect(actual).toEqual(expected);
    }
  }
});
