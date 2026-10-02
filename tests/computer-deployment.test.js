import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  hardenSupervisorDocker,
  hardenSupervisorEnvironment,
  hardenSupervisorIndex,
  publishedHostPort,
} from '../deployment/computers/harden-supervisor.mjs';

const upstream = `export function environmentFor(botId, env) {
  const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;
  return [\`COMPUTER_BOT_ID=\${botId}\`, \`COMPUTER_TOKEN=\${computerToken}\`];
}`;

const dockerUpstream = `export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      \`The supervisor could not reach Docker (\${cause}). A computer cannot be started without it.\`,
    );
    this.name = "DockerUnavailableError";
  }
}

export type EnsureOptions = {
  image: string;
  /** A network to join, when the supervisor runs alongside a compose stack. */
  network?: string;
};

function hostConfig(names, options) {
  return {
    ...(options.network
      ? {}
      : {
          // Loopback, not the world. An unqualified binding publishes on 0.0.0.0, which would put
          // every Bot's computer within reach of anything that can route to this machine. The token
          // the computer requires is the control; this keeps the surface off the network as well,
          // because both is the right number of locks on a browser holding somebody's logins.
          PortBindings: {
            [COMPUTER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        }),
  };
}

export async function ensure(
  names: ComputerNames,
  options: EnsureOptions,
): Promise<ComputerState> {
    if (
      existing &&
      (!(await runsCurrentImage(existing.image, options.image)) ||
        !holdsCurrentToken(existing.token, options.environment))
    ) {
      existing = null;
    }
  if (!existing) {
      try {
        await docker.createContainer({
          name: names.container,
          Image: options.image,
          Labels: labelsFor(names),
        });
      } catch (error) {
        throw error;
      }
  }
  return {
      ...(options.network
        ? { url: \`http://\${names.container}:4100\` }
        : settled?.port
          ? { url: \`http://127.0.0.1:\${settled.port}\` }
          : {}),
  };
}`;

const indexUpstream = `import {
  ComputerNotAnsweringError,
  DockerUnavailableError,
  ensure,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  stop,
} from "./docker";
const network = process.env.COMPUTER_NETWORK?.trim() || undefined;
app.post("/computers/:botId/ensure", async (context) => {
  try {
    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
    });
    return context.json({});
  } catch (error) {
    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});
serve({ port, fetch: app.fetch, idleTimeout: 120 });`;

it('gives each child its own credential without forwarding the master', async () => {
  const module = await import(
    `data:text/javascript,${encodeURIComponent(hardenSupervisorEnvironment(upstream))}`
  );
  const master = 'fixture-master-only-for-this-test';
  const first = module.environmentFor('dot-a', { COMPUTER_TOKEN: master });
  const second = module.environmentFor('dot-b', { COMPUTER_TOKEN: master });
  expect(first[1]).toBe(
    `COMPUTER_TOKEN=${createHmac('sha256', master).update('opendots-computer:dot-a').digest('hex')}`,
  );
  expect(first[1]).not.toBe(second[1]);
  expect(first.join()).not.toContain(master);
  expect(() =>
    module.environmentFor('dot-a', { COMPUTER_TOKEN: 'short' }),
  ).toThrow();
});

it('refuses missing or ambiguous upstream patch targets', () => {
  expect(() => hardenSupervisorEnvironment('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorEnvironment(upstream + upstream)).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorDocker('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorDocker(dockerUpstream + dockerUpstream)).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorIndex('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorIndex(indexUpstream + indexUpstream)).toThrow(
    /contract changed/,
  );
});

it('pulls COMPUTER_IMAGE before create when ensure would create a container', () => {
  const patched = hardenSupervisorDocker(dockerUpstream);
  expect(patched).toContain('export class ImageUnavailableError');
  expect(patched).toContain('async function ensureComputerImage');
  expect(patched).toContain('await ensureComputerImage(options.image);');
  expect(
    patched.indexOf('await ensureComputerImage(options.image);'),
  ).toBeLessThan(patched.indexOf('await docker.createContainer'));
  expect(patched).toContain('docker.pull(image)');
});

it('publishes cluster-reachable ports and returns access-host URLs', () => {
  const patched = hardenSupervisorDocker(dockerUpstream);
  expect(patched).toContain('accessHost?: string');
  expect(patched).toContain('HostIp: "0.0.0.0"');
  expect(patched).toContain(
    'url: `http://${options.accessHost}:${settled.port}`',
  );
  expect(patched).toContain('existing.port !== options.hostPort');
  expect(patched).toContain('HostIp: "127.0.0.1"');
});

it('wires COMPUTER_ACCESS_HOST into ensure and caps Bun idleTimeout for pulls', () => {
  const patched = hardenSupervisorIndex(indexUpstream);
  expect(patched).toMatch(/ImageUnavailableError/);
  // Bun.serve throws at boot if idleTimeout > 255 (CrashLoop on v1.0.3).
  expect(patched).toContain('idleTimeout: 255');
  expect(patched).not.toContain('idleTimeout: 120');
  expect(patched).not.toContain('idleTimeout: 600');
  expect(patched).toContain('server.timeout(req, 600)');
  expect(patched).toContain('pathname.endsWith("/ensure")');
  expect(patched).toContain('COMPUTER_ACCESS_HOST');
  expect(patched).toContain('hostPort: publishedHostPort(');
  expect(patched.indexOf('ImageUnavailableError')).toBeLessThan(
    patched.indexOf('DockerUnavailableError ||'),
  );
});

it('assigns stable publish ports inside the configured span', () => {
  const first = publishedHostPort('dot-a', 44100, 256);
  const second = publishedHostPort('dot-a', 44100, 256);
  const other = publishedHostPort('dot-b', 44100, 256);
  expect(first).toBe(second);
  expect(first).toBeGreaterThanOrEqual(44100);
  expect(first).toBeLessThan(44100 + 256);
  expect(other).toBeGreaterThanOrEqual(44100);
  expect(other).toBeLessThan(44100 + 256);
});
