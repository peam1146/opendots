import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fail closed if the pinned upstream contract changes. Only child authentication
// changes; OpenBot retains ownership of container creation, volumes and lifecycle.
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
 * Pull COMPUTER_IMAGE when ensure would create a container and the image is absent.
 *
 * Upstream OpenBot assumes the image is already local (Compose builds it first). DinD
 * deployments often have an empty engine, so create fails with "no such image" and the
 * app surfaces a bare 503. Prefer pull when missing; leave auth to the engine's
 * configured credentials (do not bake secrets into this patch).
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

  if (!next.includes('await ensureComputerImage(options.image);'))
    throw new Error(
      'Pinned OpenBot ensure image pull patch did not apply; review before building.',
    );
  if (!next.includes('export class ImageUnavailableError'))
    throw new Error(
      'Pinned OpenBot ImageUnavailableError patch did not apply; review before building.',
    );
  return next;
}

/** Surface ImageUnavailableError on ensure; lengthen idle timeout for pull+start. */
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
      idleAnchor,
      // Pull + cold start can exceed two minutes on a fresh DinD with an empty cache.
      'serve({ port, fetch: app.fetch, idleTimeout: 600 });',
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
