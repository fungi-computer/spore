import { stringWidth } from "bun";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function fitFooterCaption(text: string, width: number): string {
  const line = text.replace(/\s+/gu, " ");
  if (stringWidth(line) <= width) return line;
  if (width < 1) return "";
  let prefix = "";
  for (const { segment } of graphemes.segment(line)) {
    if (stringWidth(prefix + segment) + stringWidth("…") > width) break;
    prefix += segment;
  }
  return `${prefix}…`;
}

/**
 * Choose complete footer labels before the renderer assigns cell widths. The
 * footer is status, model and context use; it never carries key hints.
 * `width` is the row's content width: the status dot lives in the shared
 * status tail. Context use follows the model only when both fit whole.
 */
export function footerLayout({
  width,
  status,
  compactStatus,
  model = "",
  context,
}: Readonly<{
  width: number;
  status: string;
  compactStatus: string;
  model?: string | undefined;
  /** Formatted context use, e.g. `12K/200K`. */
  context?: string | undefined;
}>) {
  const budget = Math.max(0, width);
  const used = (state: string, identity: string) =>
    stringWidth([state, identity].filter(Boolean).join(" "));
  // The owner label is agent · model (reasoning) · credential. Keep the
  // model's prefix, removing complete fields before shortening its words.
  const parts = model.split(" · ");
  const identity = parts.length > 1 ? (parts[1] ?? "") : model;
  const name = identity.replace(/ \([^)]*\)$/u, "");
  const models = [
    model,
    ...(parts.length > 1 ? [parts.slice(1).join(" · ")] : []),
    identity,
    name,
  ];
  let statusText = status;
  let modelText = models.find((candidate) => used(status, candidate) <= budget);
  if (modelText === undefined) {
    statusText = compactStatus;
    // Model fields were shortened before compacting state; do not add them
    // back and lose the space the compact label just recovered.
    modelText = name;
    const prefix = name.split(" ")[0] ?? "";
    // At the narrowest widths, spend the status dot's cells on model identity.
    // The complete status word still fits without clipping.
    if (statusText.startsWith("● ") && used(statusText, prefix) > budget)
      statusText = statusText.slice(2);
    while (modelText && used(statusText, modelText) > budget) {
      const boundary = modelText.lastIndexOf(" ");
      modelText = boundary < 0 ? "" : modelText.slice(0, boundary);
    }
  }
  // Below the supported terminal widths, omit whole fields, never clip words.
  if (stringWidth(statusText) > budget) statusText = "";
  if (context !== undefined && modelText !== "") {
    const withContext = `${modelText} · ${context}`;
    if (used(statusText, withContext) <= budget) modelText = withContext;
  }
  return {
    statusText,
    modelText,
    statusWidth: stringWidth(statusText),
    modelWidth: stringWidth(modelText),
  };
}
