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
  const { colors, error } = useTerminalTheme(props.initialTheme ?? "terminal");
  return (
    <DialogSurface colors={colors} onClose={props.onCancel}>
      <SessionPickerContent {...props} themeError={props.themeError ?? error} />
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
  return (
    <>
      <Picker
        title="Resume a conversation"
        searchable
        descriptionWrap={false}
        descriptionWidth={Math.max(
          ...sessions.map((session) =>
            Bun.stringWidth(new Date(session.updatedAt).toLocaleDateString()),
          ),
          1,
        )}
        colors={colors}
        choices={sessions.map((session) => ({
          name: session.title.trim() || "Untitled",
          description: new Date(session.updatedAt).toLocaleDateString(),
        }))}
        onCancel={onCancel}
        onSelect={onSelect}
      />
      {themeError ? (
        <text marginX={1} fg={colors.error}>
          {themeError}
        </text>
      ) : null}
    </>
  );
}
