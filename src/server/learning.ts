import type { CopilotKitIntelligence } from '@copilotkit/runtime/v2';
import type { WorkspaceStore } from './workspace.js';

type Selector = NonNullable<
  ConstructorParameters<
    typeof CopilotKitIntelligence
  >[0]['getLearningContainerId']
>;

/** Called before execution, including before a new channel thread reaches DotAgent. */
export function learningSelector(
  workspace: WorkspaceStore,
  channelDotIds: string | readonly string[] = [],
): Selector {
  const allowed = new Set(
    (typeof channelDotIds === 'string'
      ? [channelDotIds]
      : [...channelDotIds]
    ).filter(Boolean),
  );
  return ({ surface, user, agentId, input }) => {
    if (user?.id !== workspace.ownerId)
      throw new Error('Conversation learning requires the workspace owner.');
    if (surface === 'channel') {
      if (!allowed.has(agentId))
        throw new Error(
          'Conversation learning requires a configured channel Dot.',
        );
      if (
        !workspace
          .conversations()
          .some((thread) => thread.id === input.threadId)
      )
        workspace.bindThread(input.threadId, agentId, 'Channel conversation');
    }
    return (
      workspace.requireThread(input.threadId, agentId).learningContainerId ??
      null
    );
  };
}
