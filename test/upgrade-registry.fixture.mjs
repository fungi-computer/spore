// An unpublished npm registry transport, not an updater replacement. The real
// published command still owns lookup, package-manager install and restart.
import { execFile } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { URL } from "node:url";
import { z } from "zod";

const execute = promisify(execFile);
const { fetch } = globalThis;
const packageManifest = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
});
const packument = z.looseObject({
  "dist-tags": z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.unknown()),
});
const tcpAddress = z.object({ port: z.number().int().min(1).max(65535) });

export async function startUpgradeRegistry(directory, tarballs) {
  const key = join(directory, "registry.key");
  const certificate = join(directory, "registry.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=registry.npmjs.org",
    "-addext",
    "subjectAltName=DNS:registry.npmjs.org",
  ]);
  const packages = await Promise.all(
    tarballs.map(async (path) => {
      const { stdout } = await execute("tar", [
        "-xOzf",
        path,
        "package/package.json",
      ]);
      const manifest = packageManifest.parse(JSON.parse(stdout));
      const bytes = await readFile(path);
      return {
        path,
        manifest,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        shasum: createHash("sha1").update(bytes).digest("hex"),
      };
    }),
  );
  const requests = [];
  let origin;
  async function candidateMetadata(entry, path) {
    const { manifest, integrity, shasum } = entry;
    const version = {
      ...manifest,
      dist: {
        integrity,
        shasum,
        tarball: `${origin}/tarballs/${packages.indexOf(entry)}.tgz`,
      },
    };
    if (path !== `/${manifest.name}`) return version;
    // Keep published versions available for the real updater's rollback.
    // Only candidate/latest is replaced in the full package metadata.
    const published = packument.parse(
      await (
        await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
        )
      ).json(),
    );
    return {
      ...published,
      name: manifest.name,
      "dist-tags": { ...published["dist-tags"], latest: manifest.version },
      versions: { ...published.versions, [manifest.version]: version },
    };
  }
  async function forwardPublicRead(url, response) {
    // Never forward caller authorization, cookies, or publication methods.
    const upstream = await fetch(
      `https://registry.npmjs.org${url.pathname}${url.search}`,
    );
    response.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
    });
    if (upstream.body === null) response.end();
    else Readable.fromWeb(upstream.body).pipe(response);
  }
  async function handleRead(request, response) {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const url = new URL(request.url, "https://registry.npmjs.org");
    const path = decodeURIComponent(url.pathname);
    requests.push(path);
    const archive = packages.find(
      (_, index) => path === `/tarballs/${index}.tgz`,
    );
    if (archive !== undefined) {
      createReadStream(archive.path).pipe(response);
      return;
    }
    const entry = packages.find(
      ({ manifest }) =>
        path === `/${manifest.name}` ||
        path === `/${manifest.name}/latest` ||
        path === `/${manifest.name}/${manifest.version}`,
    );
    if (entry !== undefined) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(await candidateMetadata(entry, path)));
      return;
    }
    await forwardPublicRead(url, response);
  }
  async function respond(request, response) {
    try {
      await handleRead(request, response);
    } catch (cause) {
      console.error("Proof registry request failed", cause);
      response.writeHead(500).end(String(cause));
    }
  }
  const secure = createSecureServer(
    {
      key: await readFile(key),
      cert: await readFile(certificate),
    },
    respond,
  );
  const server = createServer(respond);
  await new Promise((accept) => secure.listen(0, "127.0.0.1", accept));
  const secureAddress = tcpAddress.parse(secure.address());
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // Node's maintained HTTP parser decodes CONNECT; Node TLS owns the tunnel.
  server.on("connect", (request, socket, head) => {
    if (request.url !== "registry.npmjs.org:443") {
      socket.destroy();
      return;
    }
    const upstream = createConnection(secureAddress.port, "127.0.0.1");
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const address = tcpAddress.parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return {
    packages,
    requests,
    env: {
      NPM_CONFIG_REGISTRY: origin,
      HTTPS_PROXY: origin,
      HTTP_PROXY: origin,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: certificate,
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((accept, reject) => {
        secure.close((cause) =>
          cause === undefined ? accept() : reject(cause),
        );
        secure.closeAllConnections();
      });
      await new Promise((accept, reject) =>
        server.close((cause) =>
          cause === undefined ? accept() : reject(cause),
        ),
      );
    },
  };
}
