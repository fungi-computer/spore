import { useTerminalDimensions } from "@opentui/react";
import { formatWhen } from "@fungi.computer/parakeet/headless";
import { ModalHeader, modalContentWidth } from "./button/modal.js";
import { Picker } from "./button/picker.js";
import { DialogSurface, useHostColors } from "./button/dialog-surface.js";
import type { PrivateLocalSessionChoice } from "@fungi.computer/truffle/service";
import { useTerminalTheme } from "./button/terminal-theme.js";
import type { ThemeName } from "./button/theme-preferences.js";

export type SessionPickerProps = Readonly<{
  sessions: readonly PrivateLocalSessionChoice[];
  onCancel: () => void;
  onSelect: (index: number) => void;
  initialTheme?: ThemeName | undefined;
  themeError?: string | undefined;
}>;

/** Standalone picker composer; the application uses its existing DialogHost. */
export function SessionPicker(props: SessionPickerProps) {
  const { colors } = useTerminalTheme(props.initialTheme ?? "terminal");
  return (
    <DialogSurface colors={colors} onClose={props.onCancel}>
      <SessionPickerContent {...props} />
    </DialogSurface>
  );
}

export function SessionPickerContent({
  sessions,
  onCancel,
  onSelect,
  themeError,
}: SessionPickerProps) {
  const colors = useHostColors();
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 14;
  const width = modalContentWidth(dimensions.width);
  const now = Date.now();
  const whens = sessions.map((session) => formatWhen(session.updatedAt, now));
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1}>
      <ModalHeader
        content={{
          title: "Resume a conversation",
          summary: themeError ?? "Pick one to continue where you left off.",
        }}
        width={width}
        compact={compact}
        colors={colors}
      />
      <Picker
        searchable
        descriptionWrap={false}
        descriptionWidth={Math.max(
          ...whens.map((when) => Bun.stringWidth(when)),
          1,
        )}
        colors={colors}
        choices={sessions.map((session, index) => ({
          name: session.title.trim() || "Untitled",
          description: whens[index],
        }))}
        onCancel={onCancel}
        onSelect={onSelect}
      />
    </box>
  );
}
