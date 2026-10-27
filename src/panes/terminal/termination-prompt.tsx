import type { ComponentProps } from "react";
import { ModalPrompt, Picker, type PaneKit } from "../../button/index.js";

/** The shared modal header over the two safe-first termination choices. */
export function TerminationPrompt({
  quitting,
  colors,
  choices,
  onCancel,
  onSelect,
}: Readonly<{
  quitting: boolean;
  colors: ReturnType<PaneKit["theme"]["read"]>["colors"];
  choices: ComponentProps<typeof Picker>["choices"];
  onCancel: () => void;
  onSelect: (index: number) => void;
}>) {
  return (
    <ModalPrompt
      content={{
        title: quitting
          ? "Quit and terminate running shell jobs?"
          : "Close local shell and terminate its jobs?",
        summary: "Jobs still running in the shell stop when it closes.",
      }}
      colors={colors}
    >
      <Picker
        colors={colors}
        choices={choices}
        onCancel={onCancel}
        onSelect={onSelect}
      />
    </ModalPrompt>
  );
}
