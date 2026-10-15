import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { TuiFrame } from "@fungi.computer/tui/frame";
import { createDesignTuiFixture } from "./design-fixture.ts";

const fixture = createDesignTuiFixture();
const commands = createWhistle();
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const renderer = await createCliRenderer();
const root = createRoot(renderer);
root.render(
  createElement(
    QueryClientProvider,
    { client },
    createElement(TuiFrame, {
      commands,
      session: fixture.session,
      onExit: () => {
        root.unmount();
        client.clear();
        commands.close();
        renderer.destroy();
      },
    }),
  ),
);
