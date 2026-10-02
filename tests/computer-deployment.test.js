import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  hardenSupervisorDocker,
  hardenSupervisorEnvironment,
  hardenSupervisorIndex,
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

export async function ensure(
  names: ComputerNames,
  options: EnsureOptions,
): Promise<ComputerState> {
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
app.post("/computers/:botId/ensure", async (context) => {
  try {
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

it('reports ImageUnavailableError from ensure and lengthens idle timeout for pulls', () => {
  const patched = hardenSupervisorIndex(indexUpstream);
  expect(patched).toMatch(/ImageUnavailableError/);
  expect(patched).toContain('idleTimeout: 600');
  expect(patched).not.toContain('idleTimeout: 120');
  expect(patched.indexOf('ImageUnavailableError')).toBeLessThan(
    patched.indexOf('DockerUnavailableError ||'),
  );
});
