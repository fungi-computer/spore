import { EventSource } from "eventsource";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import {
  type openPrivateLocalShiitakeHost,
  type PrivateLocalRuntimeHostOptions,
  type PrivateLocalShiitakeWorkerBatch,
  type PrivateLocalShiitakeWorkerInput,
  type PrivateLocalShiitakeHost,
  type PrivateLocalShiitakeServer,
} from "@fungi.computer/truffle";
import type { ShiitakeAgent, ShiitakeSession } from "@fungi.computer/shiitake";

type PrivateLoopbackUrl = Readonly<{
  hostname: string;
  port: number;
  origin: string;
  baseUrl: string;
}>;

const loopbackHostnames = new Set(["127.0.0.1", "[::1]", "::1"]);

function parsePrivateLocalUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`Private local Shiitake endpoint is not a URL: ${value}`, {
      cause,
    });
  }
  return url;
}

function validateLoopbackAuthority(url: URL): void {
  const isLoopbackHost = loopbackHostnames.has(url.hostname);
  const hasCredentials = url.username !== "" || url.password !== "";
  if (url.protocol !== "http:" || !isLoopbackHost || hasCredentials)
    throw new Error(
      "Private local Shiitake endpoint must be loopback HTTP without credentials or a path",
    );
}

function readLoopbackPort(url: URL, requirePort: boolean): number {
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    if (requirePort)
      throw new Error(
        "Private local Shiitake listener requires an explicit port",
      );
    throw new Error("Private local Shiitake endpoint requires a port");
  }
  return port;
}

function parseLoopbackUrl(
  value: string,
  requirePort: boolean,
  allowPath = false,
): PrivateLoopbackUrl {
  const url = parsePrivateLocalUrl(value);
  validateLoopbackAuthority(url);
  const port = readLoopbackPort(url, requirePort);
  if (
    !allowPath &&
    (url.pathname !== "/" || url.search !== "" || url.hash !== "")
  )
    throw new Error(
      "Private local Shiitake listener requires an origin without a path",
    );
  if (url.search !== "" || url.hash !== "")
    throw new Error(
      "Private local Shiitake endpoint cannot contain query or fragment",
    );
  const pathname = url.pathname.replace(/\/+$/u, "");
  return Object.freeze({
    hostname: url.hostname,
    port,
    origin: url.origin,
    baseUrl: url.origin + (allowPath ? pathname : ""),
  });
}

function openPrivateBunServer(
  fetch: (request: Request) => Response | Promise<Response>,
  listenAddress?: string,
): PrivateLocalShiitakeServer {
  if (!("Bun" in globalThis))
    throw new Error("Private local Shiitake host requires Bun");
  const listener =
    listenAddress === undefined
      ? { hostname: "127.0.0.1", port: 0 }
      : parseLoopbackUrl(listenAddress, true);
  const server = Bun.serve({
    fetch,
    hostname: listener.hostname,
    port: listener.port,
  });
  return Object.freeze({
    baseUrl: server.url.origin,
    close: () => server.stop(true),
  });
}

export async function openPrivateLocalBunShiitakeHost(
  input: PrivateLocalRuntimeHostOptions,
  openHost?: Parameters<typeof openPrivateLocalShiitakeHost>[2],
  listenAddress?: string,
): Promise<PrivateLocalShiitakeHost> {
  const { openPrivateLocalShiitakeHost } =
    await import("@fungi.computer/truffle");
  return openPrivateLocalShiitakeHost(
    input,
    (fetch) => openPrivateBunServer(fetch, listenAddress),
    openHost,
    EventSource,
  );
}

/** Mount an existing private loopback host without acquiring local ownership. */
export function connectPrivateLocalBunShiitakeHost(baseUrl: string): Promise<
  Readonly<{
    baseUrl: string;
    client: ShiitakeAgent;
    session: ShiitakeSession;
    close: () => Promise<void>;
  }>
> {
  const endpoint = parseLoopbackUrl(baseUrl, false, true);
  if (!("Bun" in globalThis))
    throw new Error("Private local Shiitake connection requires Bun");
  const client = createShiitakeClient({
    baseUrl: endpoint.baseUrl,
    eventSource: EventSource,
  });
  return Promise.resolve(
    Object.freeze({
      baseUrl: endpoint.baseUrl,
      client,
      session: client.session("main"),
      close: () => client.close(),
    }),
  );
}

/** Open one Bun listener for a static batch of independent Local workers. */
export async function openPrivateLocalBunShiitakeWorkerBatch(
  inputs: readonly PrivateLocalShiitakeWorkerInput[],
  listenAddress: string,
): Promise<PrivateLocalShiitakeWorkerBatch> {
  // Validate the listener before Local owners acquire stores and leases.
  parseLoopbackUrl(listenAddress, true);
  const { openPrivateLocalShiitakeWorkerBatch } =
    await import("@fungi.computer/truffle");
  return openPrivateLocalShiitakeWorkerBatch(inputs, (fetch) =>
    openPrivateBunServer(fetch, listenAddress),
  );
}
