import { dataToUUID, isValidUUID } from '@copilotkit/shared';

/**
 * Intelligence `POST /api/threads/{id}/connect` (and related thread APIs) reject
 * non-UUID ids with 400 VALIDATION_ERROR. Discord Channels uses the channel
 * snowflake as AG-UI `threadId`; Slack self-hosted stores use `slack-…` keys.
 *
 * Map those external keys to a stable UUID v5 so SQLite bindings and web
 * `connectAgent` share an Intelligence-compatible id, while `channelKey`
 * preserves the original for channel runtime `requireThread` lookups.
 *
 * Namespace is OpenDots-specific so channel keys never collide with unrelated
 * CopilotKit `dataToUUID` callers.
 */
export const CHANNEL_THREAD_NAMESPACE = 'opendots-channel';

export function toIntelligenceThreadId(threadId: string): string {
  return isValidUUID(threadId)
    ? threadId
    : dataToUUID(threadId, CHANNEL_THREAD_NAMESPACE);
}

export function isIntelligenceThreadId(threadId: string): boolean {
  return isValidUUID(threadId);
}
