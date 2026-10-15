import {
  createElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GillRequest, GillResponse } from "@fungi.computer/gills";
import {
  type PaneKindEntry,
  PaneProvider,
  usePaneKit,
  usePaneFocused,
  usePaneKeyboard,
  usePaneStatus,
  PaneStatusLine,
  terminalText,
  z,
  conversationNavigation,
  reportFailure,
} from "../../button/index.js";

const targetSchema = z.object({
  kind: z.literal("gill"),
  surfaceId: z.string().min(1).max(256),
  viewId: z.string().min(1).max(513),
  title: z.string().max(4096).optional(),
});
type GillTarget = z.infer<typeof targetSchema>;

function GillPane({ target }: Readonly<{ target: GillTarget }>) {
  const kit = usePaneKit();
  const focused = usePaneFocused();
  const { colors } = useSyncExternalStore(kit.theme.subscribe, kit.theme.read);
  const [response, setResponse] = useState<GillResponse>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const [after, setAfter] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const signal = AbortSignal.any([kit.signal, controller.signal]);
    setBusy(true);
    try {
      if (kit.apps === undefined)
        throw new Error(
          "Sign in to Fungi and choose a Team to view its App panes",
        );
      const input: GillRequest =
        after === undefined
          ? { viewId: target.viewId }
          : { viewId: target.viewId, after };
      const next = await kit.apps.requestGill(target.surfaceId, input, signal);
      if (signal.aborted) return { kind: "retired" };
      if ("options" in next) throw new Error("This pane requires Gill rows");
      kit.setTitle(next.title);
      setResponse(next);
      setFailure(undefined);
      setSelected((current) =>
        Math.max(0, Math.min(current, next.rows.length - 1)),
      );
      return { kind: "loaded" };
    } catch (cause) {
      if (signal.aborted) return { kind: "retired", cause };
      reportFailure("gill-pane-read", cause);
      setFailure(
        cause instanceof Error
          ? cause.message
          : "This view could not be refreshed",
      );
      return { kind: "failed", cause };
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        if (!kit.signal.aborted) setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!focused) {
      request.current?.abort();
      return;
    }
    void refresh();
    return () => {
      request.current?.abort();
    };
  }, [focused, target.surfaceId, target.viewId, after]);
  async function activate() {
    const row = response?.rows[selected];
    if (row === undefined || busy || kit.apps === undefined) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const signal = AbortSignal.any([kit.signal, controller.signal]);
    setBusy(true);
    try {
      const destination =
        row.open === undefined ? undefined : conversationNavigation(row.open);
      if (signal.aborted || !kit.input.focused.read())
        return { kind: "retired" };
      if (destination !== undefined) {
        const outcome = await kit.replace({
          kind: "conversation",
          ...destination,
          title: row.title,
        });
        if (outcome.kind === "refused") throw new Error(outcome.reason);
      } else {
        request.current = undefined;
        await refresh();
      }
      return { kind: "opened" };
    } catch (cause) {
      if (!signal.aborted) {
        reportFailure("gill-pane-action", cause);
        setFailure(
          cause instanceof Error
            ? cause.message
            : "The action could not complete",
        );
      }
      return { kind: "failed", cause };
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        if (!kit.signal.aborted) setBusy(false);
      }
    }
  }
  const permanent =
    response?.state === "error" &&
    response.reason === "exec_isolation_required";
  const handlers = useRef({ refresh, activate, response, after });
  handlers.current = { refresh, activate, response, after };
  async function openUi() {
    if (kit.apps === undefined)
      throw new Error("Sign in to Fungi to open this App");
    try {
      await kit.apps.openUi(target.surfaceId, kit.signal);
      return { kind: "opened" };
    } catch (cause) {
      reportFailure("gill-pane-open-ui", cause);
      if (!kit.signal.aborted)
        setFailure(
          cause instanceof Error ? cause.message : "The App could not open",
        );
      return { kind: "failed", cause };
    }
  }
  const openUiRef = useRef(openUi);
  openUiRef.current = openUi;
  const next = response?.state === "error" ? undefined : response?.next;
  useEffect(() => {
    const lease = kit.commands.contribute([
      ...(!permanent
        ? [
            {
              id: "refresh",
              title: "Refresh view",
              category: "Panes",
              projections: {
                bindings: { values: ["r"] },
                palette: { order: 0 },
              },
              handler: () => handlers.current.refresh(),
            },
          ]
        : []),
      {
        id: "open-ui",
        title: "Open full App",
        category: "Panes",
        projections: { bindings: { values: ["o"] }, palette: { order: 1 } },
        handler: () => openUiRef.current(),
      },
      ...(next === undefined
        ? []
        : [
            {
              id: "next-page",
              title: "Next page",
              category: "Panes",
              projections: {
                bindings: { values: ["n"] },
                palette: { order: 2 },
              },
              handler: () => {
                setAfter(next);
              },
            },
          ]),
      ...(after === undefined
        ? []
        : [
            {
              id: "first-page",
              title: "First page",
              category: "Panes",
              projections: {
                bindings: { values: ["b"] },
                palette: { order: 3 },
              },
              handler: () => {
                setAfter(undefined);
              },
            },
          ]),
    ]);
    return lease.dispose;
  }, [kit.commands, permanent, next, after]);
  usePaneKeyboard((event) => {
    if (event.name === "up" || event.name === "down") {
      setSelected((current) =>
        Math.max(
          0,
          Math.min(
            (response?.rows.length ?? 1) - 1,
            current + (event.name === "up" ? -1 : 1),
          ),
        ),
      );
      return true;
    }
    if (event.name === "return" || event.name === "enter") {
      void activate();
      return true;
    }
    return false;
  });
  usePaneStatus([
    {
      slot: "state",
      order: 0,
      text: busy
        ? "Refreshing"
        : (response?.title ?? target.title ?? "App view"),
      tone: failure ? "error" : "info",
    },
  ]);
  return (
    <box flexGrow={1} flexDirection="column" paddingTop={1}>
      <scrollbox flexGrow={1}>
        {failure !== undefined ? (
          <text fg={colors.error}>{terminalText(failure)}</text>
        ) : undefined}
        {response === undefined && failure === undefined ? (
          <text>Loading…</text>
        ) : undefined}
        {response?.state === "error" ? (
          <text fg={colors.warning}>
            {terminalText(
              permanent
                ? "This view isn't available here. Open its App to continue."
                : response.error,
            )}
          </text>
        ) : undefined}
        {response?.state === "empty" ? <text>No items yet</text> : undefined}
        {response?.rows.map((row, index) => (
          <box
            key={row.id}
            paddingX={1}
            backgroundColor={
              focused && selected === index
                ? colors.selection
                : colors.background
            }
            onMouseDown={() => {
              kit.input.requestFocus();
              setSelected(index);
            }}
          >
            <text
              fg={
                focused && selected === index
                  ? colors.selectionForeground
                  : row.tone === "error"
                    ? colors.error
                    : colors.foreground
              }
            >
              {terminalText(row.title)}
            </text>
            {row.detail === undefined ? undefined : (
              <text
                fg={
                  focused && selected === index
                    ? colors.selectionForeground
                    : colors.foreground
                }
              >
                {terminalText(row.detail)}
              </text>
            )}
          </box>
        ))}
        {response?.state !== "error" && response?.next !== undefined ? (
          <text>N next page</text>
        ) : undefined}
        {after === undefined ? undefined : <text>B first page</text>}
      </scrollbox>
      <PaneStatusLine />
    </box>
  );
}

export const gillPane: PaneKindEntry = {
  kind: "gill",
  instantiate(input) {
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const target = parsed.data;
    const title = target.title?.trim();
    return {
      key: JSON.stringify([target.surfaceId, target.viewId]),
      title: title === undefined || title.length === 0 ? "App view" : title,
      render: (kit) =>
        Promise.resolve(
          createElement(
            PaneProvider,
            { kit },
            createElement(GillPane, { target }),
          ),
        ),
    };
  },
};
