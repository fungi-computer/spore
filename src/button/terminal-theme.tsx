import type { WhistleRuntime } from "@fungi.computer/whistle";
import { CliRenderEvents, RGBA, type TerminalColors } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { terminalPalette } from "@fungi.computer/stipe";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createPresentation } from "./presentation.js";
import { Picker } from "./picker.js";
import type { DialogController } from "./dialog.js";
import { themeNames, type ThemeName } from "./theme-preferences.js";
import { reportFailure } from "./log-event.js";

function stipeColor(value: string): RGBA {
  const hex = Bun.color(value, "hex");
  if (hex === null) throw new Error(`Unsupported Stipe color: ${value}`);
  return RGBA.fromHex(hex);
}

function resolveColors(
  theme: ThemeName,
  palette: TerminalColors | undefined,
  mode: "dark" | "light" | null,
) {
  if (theme === "terminal") {
    const foreground = RGBA.defaultForeground(
      palette?.defaultForeground ?? undefined,
    );
    const background = RGBA.defaultBackground(
      palette?.defaultBackground ?? undefined,
    );
    const indexed = (slot: number) => {
      const index = slot + (mode === "light" ? 0 : 8);
      return RGBA.fromIndex(index, palette?.palette[index] ?? undefined);
    };
    return {
      background,
      foreground,
      surface: foreground,
      selection: foreground,
      selectionForeground: background,
      primary: indexed(5),
      accent: indexed(5),
      success: indexed(2),
      info: indexed(4),
      warning: indexed(3),
      error: indexed(1),
    };
  }
  const colors = terminalPalette(theme);
  if (colors === undefined) throw new Error(`Missing Stipe theme: ${theme}`);
  return {
    background: stipeColor(colors.background),
    foreground: stipeColor(colors.foreground),
    surface: stipeColor(colors.surface),
    selection: stipeColor(colors.selectionBackground),
    selectionForeground: stipeColor(colors.selectionForeground),
    primary: stipeColor(colors.primary),
    accent: stipeColor(colors.accent),
    success: stipeColor(colors.success),
    info: stipeColor(colors.info),
    warning: stipeColor(colors.warning),
    error: stipeColor(colors.error),
  };
}

type PaletteSnapshot = Readonly<{
  palette: TerminalColors | undefined;
  mode: "dark" | "light" | null;
}>;
const palettes = new WeakMap<
  ReturnType<typeof useRenderer>,
  ReturnType<typeof createPaletteOwner>
>();

function createPaletteOwner(renderer: ReturnType<typeof useRenderer>) {
  let snapshot: PaletteSnapshot = {
    palette: undefined,
    mode: renderer.themeMode,
  };
  let requested = false;
  const listeners = new Set<() => void>();
  const publish = (next: PaletteSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const update = (palette: TerminalColors) => {
    publish({
      ...snapshot,
      palette,
    });
  };
  const mode = (value: "dark" | "light" | null) => {
    publish({ ...snapshot, mode: value });
  };
  let scheduled = false;
  const query = () => {
    scheduled = false;
    renderer.clearPaletteCache();
    // Missing palette replies are normal for unsupported terminals. Keep the
    // terminal defaults (or last observed colors) without announcing a fallback.
    void renderer.getPalette({ size: 16 }).then(update, () => undefined);
  };
  // Every pane workspace observing the same theme change asks in one commit;
  // the terminal is queried once for all of them.
  const refresh = () => {
    requested = true;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(query);
  };
  return {
    read: () => snapshot,
    ensure: () => {
      if (!requested) refresh();
    },
    refresh,
    subscribe: (listener: () => void) => {
      if (listeners.size === 0) {
        renderer.on(CliRenderEvents.PALETTE, update);
        renderer.on(CliRenderEvents.THEME_MODE, mode);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          renderer.off(CliRenderEvents.PALETTE, update);
          renderer.off(CliRenderEvents.THEME_MODE, mode);
        }
      };
    },
  };
}

/** One palette observer per terminal; each pane owns its syntax resources. */
export function useTerminalTheme(
  theme: ThemeName,
  options: Readonly<{ refreshOnReturnToTerminal?: boolean }> = {},
) {
  const renderer = useRenderer();
  let owner = palettes.get(renderer);
  if (owner === undefined) {
    owner = createPaletteOwner(renderer);
    palettes.set(renderer, owner);
  }
  const { palette, mode } = useSyncExternalStore(owner.subscribe, owner.read);
  const refresh = owner.refresh;
  const ensure = owner.ensure;
  const previousTheme = useRef(theme);
  useEffect(() => {
    if (theme === "terminal") {
      if (
        previousTheme.current !== "terminal" &&
        options.refreshOnReturnToTerminal !== false
      )
        refresh();
      else ensure();
    }
    previousTheme.current = theme;
  }, [theme, ensure, refresh, options.refreshOnReturnToTerminal]);
  const presentation = useMemo(() => {
    const colors = resolveColors(theme, palette, mode);
    const nativeDefaults =
      theme === "terminal"
        ? {
            foreground:
              palette?.defaultForeground === null ||
              palette?.defaultForeground === undefined
                ? undefined
                : colors.foreground,
            background:
              palette?.defaultBackground === null ||
              palette?.defaultBackground === undefined
                ? undefined
                : colors.background,
          }
        : {
            foreground: colors.foreground,
            background: colors.background,
          };
    return createPresentation(colors, theme === "terminal", nativeDefaults);
  }, [theme, palette, mode]);
  useEffect(
    () => () => {
      presentation.syntax.destroy();
    },
    [presentation],
  );
  return {
    ...presentation,
    refresh,
  };
}

const themeHints = [
  { keys: "↑↓", label: "preview", priority: 1 },
  { keys: "Enter", label: "save", priority: 0 },
  { keys: "Esc", label: "cancel", priority: 2 },
];

/** Arrows preview locally; picking a theme saves it in the same action. */
function ThemePicker({
  theme,
  colors,
  onPreview,
  onConfirm,
  onClose,
}: Readonly<{
  theme: ThemeName;
  colors: ReturnType<typeof useTerminalTheme>["colors"];
  onPreview: (theme: ThemeName | undefined) => void;
  onConfirm: (theme: ThemeName) => Promise<void>;
  onClose: () => void;
}>) {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onPreview(undefined);
    };
  }, [onPreview]);
  const confirm = async (selected: ThemeName) => {
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm(selected);
      onClose();
    } catch (error) {
      reportFailure("terminal-theme-save", error);
      if (mounted.current)
        setFailure(
          error instanceof Error ? error.message : "Unable to save theme",
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <box>
      <Picker
        title="Theme"
        choices={themeNames.map((name) => ({
          name: name.charAt(0).toUpperCase() + name.slice(1),
        }))}
        currentIndex={themeNames.indexOf(theme)}
        showDescription={false}
        disabled={saving}
        hints={themeHints}
        onHighlight={(index) => {
          const selected = themeNames[index];
          if (selected !== undefined) {
            onPreview(selected);
          }
        }}
        onSelect={(index) => {
          const selected = themeNames[index];
          if (selected !== undefined) void confirm(selected);
        }}
        onCancel={onClose}
        colors={colors}
      />
      {saving ? (
        <text fg={colors.foreground} attributes={2}>
          Saving theme…
        </text>
      ) : null}
      {failure ? <text fg={colors.error}>● {failure}</text> : null}
    </box>
  );
}

/** Theme selection owns its preview and save lifetime, beside palette observation. */
export function useThemeControls(
  dialog: Pick<DialogController, "show" | "dismiss" | "isOpen">,
  options: Readonly<{
    commands: Pick<WhistleRuntime, "contribute">;
    initialTheme: ThemeName;
    initialError: string | undefined;
    confirm: (theme: ThemeName) => Promise<void>;
  }>,
) {
  const [theme, setTheme] = useState(options.initialTheme);
  const [preview, setPreview] = useState<ThemeName>();
  const [failure, setFailure] = useState(options.initialError);
  const presentation = useTerminalTheme(preview ?? theme);
  const currentPresentation = useRef(presentation);
  currentPresentation.current = presentation;
  const open = () => {
    const confirm = options.confirm;
    let saving = false;
    dialog.show(
      (handle) => (
        <ThemePicker
          theme={theme}
          colors={currentPresentation.current.colors}
          onPreview={setPreview}
          onClose={handle.dismiss}
          onConfirm={async (selected) => {
            saving = true;
            try {
              await confirm(selected);
              if (!handle.isCurrent()) return;
              setTheme(selected);
              setFailure(undefined);
              if (selected === "terminal")
                currentPresentation.current.refresh();
            } finally {
              saving = false;
            }
          }}
        />
      ),
      { beforeDismiss: () => !saving },
    );
  };
  const openRef = useRef(open);
  openRef.current = open;
  const commands = options.commands;
  useEffect(() => {
    const lease = commands.contribute({
      sourceId: "tui-frame",
      namespace: "tui",
      commands: [
        {
          id: "theme",
          title: "Theme",
          category: "Settings",
          description: "Choose terminal colors",
          projections: {
            palette: { order: 5 },
            slash: { aliases: ["theme"], order: 5 },
          },
          handler: () => {
            openRef.current();
          },
        },
      ],
    });
    return () => {
      lease.dispose();
    };
  }, [commands]);
  return { presentation, error: failure };
}
