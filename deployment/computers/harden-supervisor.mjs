import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fail closed if the pinned upstream contract changes. Only child authentication,
// missing-image pull, and cluster publish URL selection change; OpenBot retains
// ownership of container creation, volumes and lifecycle.
export function hardenSupervisorEnvironment(source) {
  const before =
    'const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot environment contract changed; review before building.',
    );
  return `import { createHmac } from "node:crypto";\n${source.replace(
    before,
    `const master = env.COMPUTER_TOKEN?.trim();
  if (!master || master.length < 24) throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");
  const computerToken = createHmac("sha256", master).update("opendots-computer:" + botId).digest("hex");`,
  )}`;
}

/**
 * Stable host port inside COMPUTER_PUBLISH_PORT_BASE..BASE+SPAN-1 for a Dot id.
 * Used so GitOps can declare the Service port range ahead of time.
 */
export function publishedHostPort(botId, base, span) {
  let hash = 2166136261;
  for (let i = 0; i < botId.length; i++) {
    hash ^= botId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return base + ((hash >>> 0) % span);
}

/**
 * Pull COMPUTER_IMAGE when ensure would create a container and the image is absent,
 * and publish cluster-reachable ports when COMPUTER_ACCESS_HOST is configured.
 *
 * Upstream OpenBot assumes the image is already local (Compose builds it first). DinD
 * deployments often have an empty engine, so create fails with "no such image" and the
 * app surfaces a bare 503. Prefer pull when missing; leave auth to the engine's
 * configured credentials (do not bake secrets into this patch).
 *
 * Upstream also returns DinD-internal `http://{container}:4100` when COMPUTER_NETWORK
 * is set, or loopback `127.0.0.1` publishes otherwise — neither is reachable from an
 * OpenDots app Pod on the cluster CNI. When accessHost is set, publish 4100 on
 * 0.0.0.0 at a deterministic host port and advertise `http://{accessHost}:{port}`.
 */
export function hardenSupervisorDocker(source) {
  const errorAnchor = `export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      \`The supervisor could not reach Docker (\${cause}). A computer cannot be started without it.\`,
    );
    this.name = "DockerUnavailableError";
  }
}`;
  if (source.split(errorAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot DockerUnavailableError contract changed; review before building.',
    );

  const ensureAnchor =
    'export async function ensure(\n  names: ComputerNames,\n  options: EnsureOptions,\n): Promise<ComputerState> {';
  if (source.split(ensureAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot ensure export contract changed; review before building.',
    );

  const createAnchor = `      try {
        await docker.createContainer({
          name: names.container,
          Image: options.image,`;
  if (source.split(createAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot ensure create contract changed; review before building.',
    );

  const optionsAnchor = `  /** A network to join, when the supervisor runs alongside a compose stack. */
  network?: string;`;
  if (source.split(optionsAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot EnsureOptions network contract changed; review before building.',
    );

  const bindingsAnchor = `    ...(options.network
      ? {}
      : {
          // Loopback, not the world. An unqualified binding publishes on 0.0.0.0, which would put
          // every Bot's computer within reach of anything that can route to this machine. The token
          // the computer requires is the control; this keeps the surface off the network as well,
          // because both is the right number of locks on a browser holding somebody's logins.
          PortBindings: {
            [COMPUTER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        }),`;
  if (source.split(bindingsAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot hostConfig PortBindings contract changed; review before building.',
    );

  const replaceAnchor = `    if (
      existing &&
      (!(await runsCurrentImage(existing.image, options.image)) ||
        !holdsCurrentToken(existing.token, options.environment))
    ) {`;
  if (source.split(replaceAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot ensure replace contract changed; review before building.',
    );

  const urlAnchor = `      ...(options.network
        ? { url: \`http://\${names.container}:4100\` }
        : settled?.port
          ? { url: \`http://127.0.0.1:\${settled.port}\` }
          : {}),`;
  if (source.split(urlAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot ensure URL contract changed; review before building.',
    );

  const listOwnedAnchor = `export async function listOwned(): Promise<ComputerState[]> {
  try {
    const containers = (
      await docker.listContainers({
        all: true,
        filters: { label: [\`\${OWNER_LABEL}=true\`] },
      })
    ).filter((container) => ours(container.Labels));
    return containers.map((container) => ({
      botId: container.Labels?.[BOT_LABEL] ?? "unknown",
      container: (container.Names?.[0] ?? "").replace(/^\\//, ""),
      status: container.State,
      ...(container.Created
        ? { startedAt: new Date(container.Created * 1000).toISOString() }
        : {}),
      ...(portOf(container.Ports) ? { port: portOf(container.Ports) } : {}),
    }));
  } catch (error) {
    throw new DockerUnavailableError(String(error));
  }
}`;
  if (source.split(listOwnedAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot listOwned contract changed; review before building.',
    );

  let next = source.replace(
    errorAnchor,
    `${errorAnchor}

/**
 * COMPUTER_IMAGE is missing locally, or a pull to obtain it failed.
 *
 * Separate from {@link DockerUnavailableError}: the daemon answered; the image did not.
 */
export class ImageUnavailableError extends Error {
  constructor(image: string, cause: string) {
    super(
      \`Computer image \${JSON.stringify(image)} is not available locally and could not be pulled (\${cause}). Preload it into this Docker Engine, or configure registry credentials for pulls.\`,
    );
    this.name = "ImageUnavailableError";
  }
}

/** Obtain COMPUTER_IMAGE before create when the engine does not already have it. */
async function ensureComputerImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (error) {
    if (statusOf(error) !== 404) {
      throw new DockerUnavailableError(String(error));
    }
  }
  try {
    const stream = await docker.pull(image);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (error) =>
        error ? reject(error) : resolve(undefined),
      );
    });
    await docker.getImage(image).inspect();
  } catch (error) {
    throw new ImageUnavailableError(image, String(error));
  }
}`,
  );

  next = next.replace(
    createAnchor,
    `      await ensureComputerImage(options.image);

      try {
        await docker.createContainer({
          name: names.container,
          Image: options.image,`,
  );

  next = next.replace(
    optionsAnchor,
    `  /** A network to join, when the supervisor runs alongside a compose stack. */
  network?: string;
  /**
   * Cluster-reachable hostname the app uses (Service DNS). When set, ensure publishes
   * the computer on 0.0.0.0 at {@link hostPort} and returns http://accessHost:port.
   */
  accessHost?: string;
  /** Deterministic host port for {@link accessHost} publish mode. */
  hostPort?: number;`,
  );

  next = next.replace(
    bindingsAnchor,
    `    ...(options.accessHost
      ? {
          // Pod/DinD host port so a ClusterIP Service can reach the computer from the
          // app Pod. 0.0.0.0 (not loopback): loopback publishes stay inside the Pod netns.
          PortBindings: {
            [COMPUTER_PORT]: [
              {
                HostIp: "0.0.0.0",
                HostPort: String(options.hostPort ?? ""),
              },
            ],
          },
        }
      : options.network
        ? {}
        : {
            // Loopback, not the world. An unqualified binding publishes on 0.0.0.0, which would put
            // every Bot's computer within reach of anything that can route to this machine. The token
            // the computer requires is the control; this keeps the surface off the network as well,
            // because both is the right number of locks on a browser holding somebody's logins.
            PortBindings: {
              [COMPUTER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
            },
          }),`,
  );

  next = next.replace(
    replaceAnchor,
    `    if (
      existing &&
      (!(await runsCurrentImage(existing.image, options.image)) ||
        !holdsCurrentToken(existing.token, options.environment) ||
        (options.accessHost &&
          options.hostPort !== undefined &&
          existing.port !== options.hostPort))
    ) {`,
  );

  next = next.replace(
    urlAnchor,
    `      ...(options.accessHost && settled?.port
        ? { url: \`http://\${options.accessHost}:\${settled.port}\` }
        : options.network
          ? { url: \`http://\${names.container}:4100\` }
          : settled?.port
            ? { url: \`http://127.0.0.1:\${settled.port}\` }
            : {}),`,
  );

  // listContainers sometimes omits PublicPort under DinD even when inspect shows
  // HostPort. status() needs that port to build COMPUTER_ACCESS_HOST URLs.
  next = next.replace(
    listOwnedAnchor,
    `export async function listOwned(): Promise<ComputerState[]> {
  try {
    const containers = (
      await docker.listContainers({
        all: true,
        filters: { label: [\`\${OWNER_LABEL}=true\`] },
      })
    ).filter((container) => ours(container.Labels));
    return await Promise.all(
      containers.map(async (container) => {
        const name = (container.Names?.[0] ?? "").replace(/^\\//, "");
        let port = portOf(container.Ports);
        if (port === undefined) {
          try {
            const info = await docker.getContainer(name).inspect();
            if (ours(info.Config?.Labels)) {
              port = parseHostPort(
                info.NetworkSettings?.Ports?.[COMPUTER_PORT]?.[0]?.HostPort,
              );
            }
          } catch {
            // Keep listing without a port; the app reports a clear publish error.
          }
        }
        return {
          botId: container.Labels?.[BOT_LABEL] ?? "unknown",
          container: name,
          status: container.State,
          ...(container.Created
            ? { startedAt: new Date(container.Created * 1000).toISOString() }
            : {}),
          ...(port !== undefined ? { port } : {}),
        };
      }),
    );
  } catch (error) {
    throw new DockerUnavailableError(String(error));
  }
}`,
  );

  if (!next.includes('await ensureComputerImage(options.image);'))
    throw new Error(
      'Pinned OpenBot ensure image pull patch did not apply; review before building.',
    );
  if (!next.includes('export class ImageUnavailableError'))
    throw new Error(
      'Pinned OpenBot ImageUnavailableError patch did not apply; review before building.',
    );
  if (!next.includes('options.accessHost'))
    throw new Error(
      'Pinned OpenBot cluster accessHost patch did not apply; review before building.',
    );
  if (!next.includes('HostIp: "0.0.0.0"'))
    throw new Error(
      'Pinned OpenBot cluster PortBindings patch did not apply; review before building.',
    );
  if (!next.includes('info.NetworkSettings?.Ports?.[COMPUTER_PORT]'))
    throw new Error(
      'Pinned OpenBot listOwned port inspect patch did not apply; review before building.',
    );
  return next;
}

/**
 * Surface ImageUnavailableError on ensure; wire access host; keep Bun.serve bootable.
 *
 * Bun.serve hard-caps global idleTimeout at 255s (values above throw at boot → CrashLoop).
 * Cold DinD COMPUTER_IMAGE pull + ensure can exceed that, so raise the ensure path only via
 * server.timeout (aligned with OpenDots ENSURE_DEADLINE_MS ≈ 580s).
 */
export function hardenSupervisorIndex(source) {
  const importAnchor = `import {
  ComputerNotAnsweringError,
  DockerUnavailableError,
  ensure,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  stop,
} from "./docker";`;
  if (source.split(importAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot supervisor import contract changed; review before building.',
    );

  const networkAnchor =
    'const network = process.env.COMPUTER_NETWORK?.trim() || undefined;';
  if (source.split(networkAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot COMPUTER_NETWORK contract changed; review before building.',
    );

  const ensureCallAnchor = `    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
    });`;
  if (source.split(ensureCallAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot ensure call contract changed; review before building.',
    );

  const catchAnchor = `    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;`;
  if (source.split(catchAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot ensure catch contract changed; review before building.',
    );

  const idleAnchor = 'serve({ port, fetch: app.fetch, idleTimeout: 120 });';
  if (source.split(idleAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot serve idleTimeout contract changed; review before building.',
    );

  const listRouteAnchor = `app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});`;
  if (source.split(listRouteAnchor).length !== 2)
    throw new Error(
      'Pinned OpenBot GET /computers contract changed; review before building.',
    );

  return source
    .replace(
      importAnchor,
      `import {
  ComputerNotAnsweringError,
  DockerUnavailableError,
  ensure,
  ImageUnavailableError,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  stop,
} from "./docker";`,
    )
    .replace(
      networkAnchor,
      `${networkAnchor}
/** Cluster DNS name the OpenDots app uses to reach published computer ports. */
function accessHostname(raw: string | undefined): string | undefined {
  const host = raw?.trim().toLowerCase();
  if (!host) return undefined;
  if (
    host.length > 253 ||
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ||
    host.includes("..")
  ) {
    throw new Error(
      "COMPUTER_ACCESS_HOST must be a DNS hostname (Service name), without scheme or port.",
    );
  }
  return host;
}
function publishPortRange(
  baseRaw: string | undefined,
  spanRaw: string | undefined,
): { base: number; span: number } {
  const base = baseRaw?.trim() ? Number.parseInt(baseRaw.trim(), 10) : 44100;
  const span = spanRaw?.trim() ? Number.parseInt(spanRaw.trim(), 10) : 256;
  if (
    !Number.isSafeInteger(base) ||
    !Number.isSafeInteger(span) ||
    base < 1024 ||
    span < 1 ||
    span > 4096 ||
    base + span - 1 > 65535
  ) {
    throw new Error(
      "COMPUTER_PUBLISH_PORT_BASE/SPAN must yield ports in 1024-65535 (span 1-4096).",
    );
  }
  return { base, span };
}
function publishedHostPort(botId: string, base: number, span: number): number {
  let hash = 2166136261;
  for (let i = 0; i < botId.length; i++) {
    hash ^= botId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return base + ((hash >>> 0) % span);
}
let accessHost: string | undefined;
let publishPorts: { base: number; span: number };
try {
  accessHost = accessHostname(process.env.COMPUTER_ACCESS_HOST);
  publishPorts = publishPortRange(
    process.env.COMPUTER_PUBLISH_PORT_BASE,
    process.env.COMPUTER_PUBLISH_PORT_SPAN,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}`,
    )
    .replace(
      ensureCallAnchor,
      `    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
      ...(accessHost
        ? {
            accessHost,
            hostPort: publishedHostPort(
              parsed.names.botId,
              publishPorts.base,
              publishPorts.span,
            ),
          }
        : {}),
    });`,
    )
    .replace(
      catchAnchor,
      `    if (error instanceof ImageUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;`,
    )
    .replace(
      listRouteAnchor,
      `app.get("/computers", async (context) => {
  try {
    const computers = await listOwned();
    return context.json({
      computers: accessHost
        ? computers.map((computer) =>
            computer.port
              ? {
                  ...computer,
                  url: \`http://\${accessHost}:\${computer.port}\`,
                }
              : computer,
          )
        : computers,
    });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});`,
    )
    .replace(
      idleAnchor,
      `serve({
  port,
  // Bun.serve rejects idleTimeout > 255 at boot; keep the global max for non-ensure routes.
  idleTimeout: 255,
  fetch(req, server) {
    // Cold DinD pull + ensure can exceed 255s; OpenDots client budget is ~580s.
    if (new URL(req.url).pathname.endsWith("/ensure")) {
      server.timeout(req, 600);
    }
    return app.fetch(req, server);
  },
});`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.argv[2];
  if (!root) throw new Error('Pass the pinned supervisor src directory.');
  const environmentPath = join(root, 'environment.ts');
  const dockerPath = join(root, 'docker.ts');
  const indexPath = join(root, 'index.ts');
  await writeFile(
    environmentPath,
    hardenSupervisorEnvironment(await readFile(environmentPath, 'utf8')),
  );
  await writeFile(
    dockerPath,
    hardenSupervisorDocker(await readFile(dockerPath, 'utf8')),
  );
  await writeFile(
    indexPath,
    hardenSupervisorIndex(await readFile(indexPath, 'utf8')),
  );
}
