import { expect, it } from 'vitest';
import {
  discordConfigured,
  discordUserAllowed,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  intelligenceKey: 'fixture',
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
  discordUsers: [],
};
it('never claims Slack online without a complete managed channel declaration', () => {
  expect(setupStatus(config, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...config, slackChannel: 'support' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...config,
        slackChannel: 'support',
        slackTeam: 'team',
        slackUsers: ['owner'],
      },
      'online',
    ).slack,
  ).toBe('online');
});
it('never claims Discord online without a complete direct adapter declaration', () => {
  expect(setupStatus(config, 'online').discord).toBe('not_configured');
  expect(
    setupStatus({ ...config, discordBotToken: 'token' }, 'online').discord,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...config,
        discordChannel: 'opendots-discord',
        discordBotToken: 'token',
        discordAppId: 'app',
        discordGuild: 'guild',
        discordUsers: ['person'],
      },
      'online',
    ).discord,
  ).toBe('online');
});
it('treats a lone * Discord allowlist as configured while empty stays not configured', () => {
  const base = {
    discordChannel: 'opendots-discord',
    discordBotToken: 'token',
    discordAppId: 'app',
    discordGuild: 'guild',
  };
  expect(discordConfigured({ ...base, discordUsers: [] })).toBe(false);
  expect(discordConfigured({ ...base, discordUsers: ['*'] })).toBe(true);
  expect(
    setupStatus({ ...config, ...base, discordUsers: ['*'] }, 'online').discord,
  ).toBe('online');
  expect(
    setupStatus({ ...config, ...base, discordUsers: [] }, 'online').discord,
  ).toBe('setup_required');
});
it('matches Discord allowlists for * vs explicit ids vs empty', () => {
  expect(discordUserAllowed(['*'], 'anyone')).toBe(true);
  expect(discordUserAllowed(['person'], 'person')).toBe(true);
  expect(discordUserAllowed(['person'], 'other')).toBe(false);
  expect(discordUserAllowed(['person', 'other'], 'other')).toBe(true);
  expect(discordUserAllowed([], 'anyone')).toBe(false);
  expect(discordUserAllowed(['*', 'person'], 'anyone')).toBe(false);
});
it('requires Intelligence and model setup and disables voice when either is absent', () => {
  expect(
    setupStatus({
      ...config,
      intelligenceKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ missing: ['INTELLIGENCE_API_KEY'], voice: false });
});
it('reports activation failure until the SDK recovers online', () => {
  const declared = {
    ...config,
    slackChannel: 'support',
    slackTeam: 'team',
    slackUsers: ['owner'],
    discordChannel: 'opendots-discord',
    discordBotToken: 'token',
    discordAppId: 'app',
    discordGuild: 'guild',
    discordUsers: ['person'],
  };
  expect(setupStatus(declared, 'offline', true).slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'offline', true).discord).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'online', true).slack).toBe('online');
  expect(setupStatus(declared, 'online', true).discord).toBe('online');
});
