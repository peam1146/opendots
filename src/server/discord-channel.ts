import {
  createChannel,
  type ChannelIdentityContext,
  type IncomingMessage,
  type Thread,
} from '@copilotkit/channels';
import { discord } from '@copilotkit/channels/discord';
import {
  reportChannelFailure,
  safeFailure,
  type ChannelFailureReport,
} from './channel-safety.js';
import { discordUserAllowed, type PlatformConfig } from './platform-config.js';

export type DiscordConfig = Pick<
  PlatformConfig,
  | 'discordChannel'
  | 'discordBotToken'
  | 'discordAppId'
  | 'discordGuild'
  | 'discordUsers'
>;

type Turn = {
  thread: Pick<Thread, 'runAgent' | 'post' | 'subscribe' | 'isSubscribed'>;
  message: IncomingMessage;
};

export function discordIdentity(
  context: ChannelIdentityContext,
  config: DiscordConfig,
  ownerId: string,
) {
  if (
    context.provider !== 'discord' ||
    context.tenant.id !== config.discordGuild ||
    context.actor.kind !== 'human' ||
    !discordUserAllowed(config.discordUsers, context.actor.id)
  )
    return null;
  return { id: ownerId, name: 'OpenDots owner' };
}

export function discordHandlers(options: {
  config: DiscordConfig;
  ownerId: string;
  paused: () => boolean;
  report?: ChannelFailureReport;
}) {
  const report = options.report ?? reportChannelFailure;
  const eligible = ({ message }: Turn) =>
    message.platform === 'discord' &&
    message.user?.id === options.ownerId &&
    message.actor.kind === 'human' &&
    discordUserAllowed(options.config.discordUsers, message.actor.id) &&
    (message.operation?.kind ?? 'created') === 'created';
  async function notice(thread: Turn['thread'], text: string) {
    try {
      await thread.post(text);
    } catch (error) {
      const safe = safeFailure(error);
      report('Discord notice failed', [safe]);
      throw new Error(`Discord notice failed: ${safe}`, {
        // eslint-disable-next-line preserve-caught-error -- Raw provider causes can expose credentials through SDK logging.
        cause: safeFailure(error),
      });
    }
  }
  async function run(thread: Turn['thread']) {
    if (options.paused()) {
      await notice(
        thread,
        'OpenDots is paused. Resume it in the app before asking me to continue.',
      );
      return;
    }
    try {
      await thread.runAgent();
    } catch (error) {
      const runError = safeFailure(error);
      try {
        await thread.post(
          'I couldn’t complete that request. Please check OpenDots and send a new message when you’re ready to try again.',
        );
      } catch (postError) {
        const replyError = safeFailure(postError);
        report('Discord agent run and error reply failed', [
          runError,
          replyError,
        ]);
        throw new AggregateError(
          [
            new Error(`Agent run: ${runError}`),
            new Error(`Error reply: ${replyError}`),
          ],
          'Discord agent run and error reply failed',
          // eslint-disable-next-line preserve-caught-error -- Retain only the safe cause; the SDK may log thrown errors.
          { cause: safeFailure(postError) },
        );
      }
      report('Discord agent run failed; error reply posted', [runError]);
    }
  }
  return {
    async mention(turn: Turn) {
      if (!eligible(turn)) return;
      if (options.paused()) {
        await run(turn.thread);
        return;
      }
      try {
        await turn.thread.subscribe();
      } catch (error) {
        report('Discord thread subscription failed; answering mention', [
          safeFailure(error),
        ]);
      }
      await run(turn.thread);
    },
    async message(turn: Turn) {
      if (!eligible(turn)) return;
      let subscribed: boolean;
      try {
        subscribed = await turn.thread.isSubscribed();
      } catch (error) {
        const safe = safeFailure(error);
        report('Discord subscription lookup failed', [safe]);
        throw new Error(`Discord subscription lookup failed: ${safe}`, {
          // eslint-disable-next-line preserve-caught-error -- Raw provider causes can expose credentials through SDK logging.
          cause: safeFailure(error),
        });
      }
      if (subscribed) await run(turn.thread);
    },
  };
}

export function createDiscordChannel(options: {
  name: string;
  agent: NonNullable<Parameters<typeof createChannel>[0]['agent']>;
  config: DiscordConfig;
  ownerId: string;
  paused: () => boolean;
}) {
  if (
    !options.config.discordBotToken ||
    !options.config.discordAppId ||
    !options.config.discordGuild
  )
    throw new Error(
      'Discord channel requires DISCORD_BOT_TOKEN, DISCORD_APP_ID, and DISCORD_GUILD_ID.',
    );
  const channel = createChannel({
    name: options.name,
    agent: options.agent,
    adapters: [
      discord({
        botToken: options.config.discordBotToken,
        appId: options.config.discordAppId,
        guildId: options.config.discordGuild,
      }),
    ],
    identifyUser: (context) =>
      discordIdentity(context, options.config, options.ownerId),
    store: { concurrency: 'serial' },
  });
  const handlers = discordHandlers(options);
  // Channels dispatches a mention to onMention exclusively, so it is not run twice.
  channel.onMention(handlers.mention);
  channel.onMessage(handlers.message);
  return channel;
}
