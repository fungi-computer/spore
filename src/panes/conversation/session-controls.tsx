import { useEffect, useRef } from "react";
import {
  contributeSessionCommands,
  type ParakeetSession,
} from "@fungi.computer/parakeet/headless";
import type { WhistleRuntime } from "@fungi.computer/whistle";

/**
 * A selected Session owns its host commands: Session reading, the queue,
 * resume and new. Goal, loop and every other extension command arrive from
 * the Session's advertised catalog through Parakeet.
 */
export function useSessionControls(
  input: Readonly<{
    session: ParakeetSession;
    commands: Pick<WhistleRuntime, "contribute">;
    resume: (() => void | Promise<void>) | undefined;
    create: (() => void | Promise<void>) | undefined;
    onForked: ((sessionId: string) => void | Promise<void>) | undefined;
    onTitled: ((title: string | null) => void | Promise<void>) | undefined;
    onEditQueued: (text: string) => void;
    canEditQueued: () => boolean;
  }>,
) {
  const { session, commands } = input;
  const view = useRef(input);
  view.current = input;
  const available = input.resume !== undefined;
  const forkAvailable = input.onForked !== undefined;
  useEffect(() => {
    let current = true;
    const selected = () => current && view.current.session === session;
    const lease = contributeSessionCommands(commands, session, {
      sourceId: "tui-session",
      namespace: "session",
      sessionResumeAvailable: available,
      sessionResume: async () => {
        if (selected()) await view.current.resume?.();
      },
      forkAvailable,
      onForked: async (sessionId: string) => {
        if (selected()) await view.current.onForked?.(sessionId);
      },
      onEditQueued: (text: string) => {
        if (selected()) view.current.onEditQueued(text);
      },
      canEditQueued: () => selected() && view.current.canEditQueued(),
      onTitled: async (title: string | null) => {
        if (selected()) await view.current.onTitled?.(title);
      },
    });
    return () => {
      current = false;
      lease.dispose();
    };
  }, [commands, session, available, forkAvailable]);
  useEffect(() => {
    let current = true;
    const lease = commands.contribute({
      sourceId: "tui-frame",
      namespace: "tui",
      commands: [
        {
          id: "new",
          title: "New conversation",
          category: "Conversation",
          projections: {
            palette: { order: -1 },
            slash: { aliases: ["new"], order: 9 },
          },
          handler: async () => {
            if (!current || view.current.session !== session)
              throw new Error("The selected Session changed.");
            const create = view.current.create;
            if (create === undefined)
              throw new Error(
                "Starting a new Session is unavailable for this connection.",
              );
            await create();
          },
        },
      ],
    });
    return () => {
      current = false;
      lease.dispose();
    };
  }, [commands, session]);
}
