import type { SetupStatus } from '../shared/types.js';

export interface PlatformConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  /** Stable Responses affinity / prompt-cache key (Chimera and OpenAI). */
  promptCacheKey?: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  discordChannel?: string;
  discordBotToken?: string;
  discordAppId?: string;
  discordGuild?: string;
  discordUsers: string[];
  discordDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}

/** Complete direct Discord adapter declaration (optional; parallel to managed Slack). */
export function discordConfigured(
  config: Pick<
    PlatformConfig,
    | 'discordChannel'
    | 'discordBotToken'
    | 'discordAppId'
    | 'discordGuild'
    | 'discordUsers'
  >,
): boolean {
  return !!(
    config.discordChannel &&
    config.discordBotToken &&
    config.discordAppId &&
    config.discordGuild &&
    config.discordUsers.length
  );
}

function channelSetupState(
  declared: boolean,
  partial: boolean,
  overall: string,
  activationFailed: boolean,
): string {
  if (!declared) return partial ? 'setup_required' : 'not_configured';
  if (activationFailed && overall !== 'online') return 'activation_failed';
  return overall;
}

export function setupStatus(
  config: PlatformConfig,
  overall = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.intelligenceKey && 'INTELLIGENCE_API_KEY',
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  const partialSlack = !!(
    config.slackChannel ||
    config.slackTeam ||
    config.slackUsers.length
  );
  const declaredDiscord = discordConfigured(config);
  const partialDiscord = !!(
    config.discordChannel ||
    config.discordBotToken ||
    config.discordAppId ||
    config.discordGuild ||
    config.discordUsers.length
  );
  return {
    intelligence: !!config.intelligenceKey,
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack: channelSetupState(
      declaredSlack,
      partialSlack,
      overall,
      activationFailed,
    ),
    discord: channelSetupState(
      declaredDiscord,
      partialDiscord,
      overall,
      activationFailed,
    ),
    missing,
  };
}
