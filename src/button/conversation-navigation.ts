import type { RowV1 } from "@fungi.computer/gills";
import { z } from "zod";

const conversationParams = z.object({
  agent: z.string().min(1).max(256),
  session: z.string().min(1).max(256),
});

/** Grove owns agent/session navigation; other App parameters are not Session targets. */
export function conversationNavigation(open: NonNullable<RowV1["open"]>) {
  const target = conversationParams.parse(
    Object.fromEntries(open.params.map(({ key, value }) => [key, value])),
  );
  return { agentId: target.agent, sessionId: target.session };
}
