import { expect, it, vi } from 'vitest';
import { createChannel } from '@copilotkit/channels';
import { HttpAgent } from '@ag-ui/client';
import { createDiscordChannel } from '../src/server/discord-channel.js';

const discord = vi.hoisted(() =>
  vi.fn(() => ({ platform: 'discord', start: vi.fn(), stop: vi.fn() })),
);
vi.mock('@copilotkit/channels/discord', () => ({
  discord,
}));
vi.mock('@copilotkit/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@copilotkit/channels')>();
  return {
    ...actual,
    createChannel: vi.fn(
      (options: Parameters<typeof actual.createChannel>[0]) => {
        const channel = actual.createChannel(options);
        vi.spyOn(channel, 'onMention');
        vi.spyOn(channel, 'onMessage');
        return channel;
      },
    ),
  };
});

it('registers a direct Discord adapter with distinct mention and message handlers', () => {
  const channel = createDiscordChannel({
    name: 'opendots-discord',
    agent: () => new HttpAgent({ url: 'http://unused.invalid' }),
    config: {
      discordChannel: 'opendots-discord',
      discordBotToken: 'token',
      discordAppId: 'app',
      discordGuild: 'guild',
      discordUsers: ['person'],
    },
    ownerId: 'owner',
    paused: () => false,
  });
  expect(channel.name).toBe('opendots-discord');
  expect(discord).toHaveBeenCalledWith({
    botToken: 'token',
    appId: 'app',
    guildId: 'guild',
  });
  expect(createChannel).toHaveBeenCalledWith(
    expect.objectContaining({
      store: { concurrency: 'serial' },
      identifyUser: expect.any(Function),
      adapters: [expect.objectContaining({ platform: 'discord' })],
    }),
  );
  expect(channel.onMention).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
  );
  expect(channel.onMessage).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
  );
  expect(vi.mocked(channel.onMention).mock.calls[0][0]).not.toBe(
    vi.mocked(channel.onMessage).mock.calls[0][0],
  );
});
