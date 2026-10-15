import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { gutterSigils } from "../dist/button/tool-sigils.js";
import { isSigilName } from "@fungi.computer/sigils";
import { z } from "zod";

/** Regenerate the owned artwork; the source freshness law uses default geometry. */
export async function generateToolSigilImages(width = 8, height = 16) {
  const dimension = z.coerce.number().int().min(1).max(256);
  const cellWidth = dimension.parse(width);
  const cellHeight = dimension.parse(height);
  // Sigils also serves React 18 consumers. Bundle its SVG component with this
  // renderer's React runtime rather than mixing element representations.
  const bundled = await build({
    entryPoints: [fileURLToPath(import.meta.resolve("@fungi.computer/sigils"))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    alias: {
      react: fileURLToPath(new URL("../node_modules/react", import.meta.url)),
    },
  });
  const { Sigil } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  // The placement spans three columns, not two: the pane's own left inset
  // is free space (nothing else draws there), and the gutter dot this
  // artwork must match sits in the SECOND of the three (the same single
  // cell it has always occupied -- it never moves). "contain" also centers
  // the resized SVG's own canvas, not its opaque pixels, so first measure
  // each icon's real opaque bounding box at its original, unshrunk size
  // (unchanged from before this fix), then composite that unchanged
  // artwork onto the wider three-column canvas at the one offset that
  // puts its opaque center exactly on the dot's own center -- one cell in
  // from the canvas's left edge, plus the half-cell the dot sits in from
  // there. There is always enough room in the extra column to do this
  // without clipping, on both axes.
  const opaqueBoundingBox = async (png) => {
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * channels + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return undefined;
    return { centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
  };
  const images = {};
  for (const name of new Set(Object.values(gutterSigils))) {
    if (!isSigilName(name)) throw new Error(`Unknown tool sigil: ${name}`);
    const svg = renderToStaticMarkup(createElement(Sigil, { name, size: 64 }));
    images[name] = await Promise.all(
      [1, 2].map(async (scale) => {
        const naturalWidth = cellWidth * 2 * scale;
        const naturalHeight = cellHeight * scale;
        const natural = await sharp(Buffer.from(svg))
          .resize(naturalWidth, naturalHeight, {
            fit: "contain",
            background: transparent,
          })
          .png()
          .toBuffer();
        const bbox = await opaqueBoundingBox(natural);
        const canvasWidth = cellWidth * 3 * scale;
        const canvasHeight = naturalHeight;
        // The dot's own center: one full cell in from this wider canvas's
        // left edge (the reclaimed inset column), plus the half-cell the
        // dot centers within inside its own (unchanged) single gutter cell.
        const dotCenterX = cellWidth * scale * 1.5;
        const dotCenterY = canvasHeight / 2;
        const left = bbox
          ? Math.round(dotCenterX - bbox.centerX)
          : Math.round(cellWidth * scale * 0.5);
        const top = bbox ? Math.round(dotCenterY - bbox.centerY) : 0;
        const png = await sharp({
          create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 4,
            background: transparent,
          },
        })
          .composite([{ input: natural, left, top }])
          .png()
          .toBuffer();
        return png.toString("base64");
      }),
    );
  }
  return { cellWidth, cellHeight, images };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({ options: { update: { type: "boolean" } } });
  const source = new URL("../src/tool-sigil-images.json", import.meta.url);
  if (values.update) {
    await writeFile(
      source,
      `${JSON.stringify(await generateToolSigilImages(), null, 2)}\n`,
    );
  } else {
    // The normal build consumes the checked-in default input. Explicit geometry
    // still regenerates pixels to fit the operator's reported cell dimensions.
    const images =
      process.env.TUI_SIGIL_CELL_WIDTH || process.env.TUI_SIGIL_CELL_HEIGHT
        ? await generateToolSigilImages(
            process.env.TUI_SIGIL_CELL_WIDTH ?? 8,
            process.env.TUI_SIGIL_CELL_HEIGHT ?? 16,
          )
        : JSON.parse(await readFile(source, "utf8"));
    const output = new URL("../dist/tool-sigil-images.json", import.meta.url);
    await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
    await writeFile(output, JSON.stringify(images));
  }
}
