import { terminalText } from "./terminal-text.js";
import type {
  SlashCommandController,
  SlashCompletion,
} from "@fungi.computer/parakeet/headless";
import type { TuiPresentation } from "./presentation.js";
import { PickerInline, type PickerInlineRow } from "./picker.js";

/** The rows Parakeet ranked, in its order; the terminal only lays them out. */
export function slashRows(
  completion: SlashCompletion,
): readonly PickerInlineRow[] {
  if (completion.kind === "commands")
    return completion.items.map((item) => {
      const keys = item.command.keys.join(", ");
      return {
        key: item.command.commandId + item.label,
        label: terminalText(item.label),
        detail: [item.command.description ?? item.command.title, keys]
          .filter((part) => part.length > 0)
          .join(" · "),
      };
    });
  if (completion.kind === "arguments")
    return completion.items.map((item) => ({
      key: item.label,
      label: terminalText(item.label),
      detail: terminalText(item.word.description ?? ""),
    }));
  return [];
}

/** Draw Parakeet's slash completion above the composer through Picker's inline layout. */
export function SlashCompletionList({
  slash,
  colors,
  maxRows,
  width,
}: Readonly<{
  slash: SlashCommandController;
  colors: TuiPresentation["colors"];
  maxRows: number;
  width: number;
}>) {
  const { completion, selected } = slash;
  return (
    <PickerInline
      rows={slashRows(completion)}
      selected={selected}
      onChoose={(index) => {
        slash.choose(index);
      }}
      header={
        completion.kind === "arguments"
          ? completion.hint
          : completion.kind === "commands" && completion.items.length > maxRows
            ? "More… · ↑↓ to browse all commands"
            : undefined
      }
      maxRows={maxRows}
      width={width}
      colors={colors}
    />
  );
}
