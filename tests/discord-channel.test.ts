import { expect, it, vi } from 'vitest';
import type {
  ChannelIdentityContext,
  IncomingMessage,
  Thread,
} from '@copilotkit/channels';
import {
  discordIdentity,
  discordHandlers,
} from '../src/server/discord-channel.js';
const config = {
  discordChannel: 'opendots-discord',
  discordBotToken: 'token',
  discordAppId: 'app',
  discordGuild: 'guild',
  discordUsers: ['person'],
};
const identity: ChannelIdentityContext = {
  provider: 'discord',
  tenant: { id: 'guild' },
  installation: { id: 'app' },
  actor: { id: 'person', kind: 'human' },
  conversation: { id: 'conversation' },
  trigger: 'message',
  event: { id: 'event' },
  raw: null,
};
const message: IncomingMessage = {
  text: 'Help',
  user: { id: 'owner', name: 'Owner' },
  actor: { id: 'person', kind: 'human' },
  ref: { id: 'message' },
  platform: 'discord',
  operation: {
    kind: 'created',
    mentioned: true,
    logicalMessageId: 'message',
    revisionId: '1',
  },
};
function fixture(paused = false) {
  const thread = {
    runAgent: vi.fn<Thread['runAgent']>(async () => undefined),
    post: vi.fn<Thread['post']>(async () => ({ id: 'reply' })),
    subscribe: vi.fn<Thread['subscribe']>(async () => {}),
    isSubscribed: vi.fn<Thread['isSubscribed']>(async () => false),
  };
  const report = vi.fn();
  return {
    thread,
    report,
    handlers: discordHandlers({
      config,
      ownerId: 'owner',
      paused: () => paused,
      report,
    }),
  };
}
it('requires explicit Discord guild and user allowlists for canonical owner identity', () => {
  expect(discordIdentity(identity, config, 'owner')?.id).toBe('owner');
  expect(
    discordIdentity({ ...identity, tenant: { id: 'other' } }, config, 'owner'),
  ).toBeNull();
  expect(
    discordIdentity(
      { ...identity, actor: { id: 'other', kind: 'human' } },
      config,
      'owner',
    ),
  ).toBeNull();
  expect(
    discordIdentity({ ...identity, provider: 'slack' }, config, 'owner'),
  ).toBeNull();
});
it('answers an allowed mention once, then only subscribed follow-ups', async () => {
  const f = fixture();
  await f.handlers.mention({ thread: f.thread, message });
  expect(f.thread.subscribe).toHaveBeenCalledTimes(1);
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);
  await f.handlers.message({ thread: f.thread, message });
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);
  f.thread.isSubscribed.mockResolvedValue(true);
  await f.handlers.message({ thread: f.thread, message });
  expect(f.thread.runAgent).toHaveBeenCalledTimes(2);
});
it('ignores nonhuman actors and changed/deleted messages without side effects', async () => {
  const f = fixture();
  for (const kind of ['bot', 'app', 'system', 'unknown'] as const)
    await f.handlers.mention({
      thread: f.thread,
      message: { ...message, actor: { ...message.actor, kind } },
    });
  for (const kind of ['updated', 'deleted'] as const)
    await f.handlers.mention({
      thread: f.thread,
      message: { ...message, operation: { ...message.operation!, kind } },
    });
  await f.handlers.mention({
    thread: f.thread,
    message: { ...message, user: null },
  });
  expect(f.thread.runAgent).not.toHaveBeenCalled();
  expect(f.thread.subscribe).not.toHaveBeenCalled();
  expect(f.thread.post).not.toHaveBeenCalled();
});
it('defaults an absent operation to created and reports pause without subscribing or running', async () => {
  const f = fixture(true);
  await f.handlers.mention({
    thread: f.thread,
    message: { ...message, operation: undefined },
  });
  expect(f.thread.post).toHaveBeenCalledWith(expect.stringMatching(/paused/i));
  expect(f.thread.subscribe).not.toHaveBeenCalled();
  expect(f.thread.runAgent).not.toHaveBeenCalled();
});
it('isolates a failed run after a safe reply and surfaces both failures if posting also fails', async () => {
  const f = fixture();
  f.thread.runAgent.mockRejectedValue(new Error('SECRET provider details'));
  await f.handlers.mention({ thread: f.thread, message });
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);
  expect(f.thread.post.mock.calls[0][0]).not.toContain('SECRET');
  expect(f.report).toHaveBeenCalled();
  f.thread.post.mockRejectedValue(new Error('SECRET reply details'));
  await expect(
    f.handlers.mention({ thread: f.thread, message }),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(JSON.stringify(f.report.mock.calls)).not.toContain('SECRET');
});
it('still answers mentions when subscribing fails, but never runs on unreadable subscription state', async () => {
  const f = fixture();
  f.thread.subscribe.mockRejectedValue(new Error('Failure'));
  await f.handlers.mention({ thread: f.thread, message });
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);
  f.thread.isSubscribed.mockRejectedValue(new Error('Failure'));
  await expect(
    f.handlers.message({ thread: f.thread, message }),
  ).rejects.toThrow();
  expect(f.thread.runAgent).toHaveBeenCalledTimes(1);
});
it('surfaces a failed pause notice safely and never runs or subscribes', async () => {
  const f = fixture(true);
  f.thread.post.mockRejectedValue(new Error('SECRET token'));
  await expect(
    f.handlers.mention({ thread: f.thread, message }),
  ).rejects.toThrow('Discord notice failed: Error');
  expect(f.thread.runAgent).not.toHaveBeenCalled();
  expect(f.thread.subscribe).not.toHaveBeenCalled();
  expect(JSON.stringify(f.report.mock.calls)).not.toContain('SECRET');
});
