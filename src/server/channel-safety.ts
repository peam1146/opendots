// Never pass provider messages/stacks to logs or Slack/Discord: they can contain credentials.
export function safeFailure(error: unknown): string {
  const name =
    error instanceof Error &&
    ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
      ? error.name
      : 'Error';
  const status =
    error !== null && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? `${name} (HTTP ${status})`
    : name;
}

export type ChannelFailureReport = (
  operation: string,
  errors: string[],
) => void;

export const reportChannelFailure: ChannelFailureReport = (operation, errors) =>
  console.error(`${operation}: ${errors.join('; ')}`);
