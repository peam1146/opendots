/** Minimal OpenAI Responses API SSE stream for TanStack compatible tests. */
export function completion(
  delta: Record<string, unknown>,
  finishReason = 'stop',
) {
  const toolCalls = Array.isArray(delta.tool_calls)
    ? (delta.tool_calls as Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>)
    : [];
  const events =
    finishReason === 'tool_calls' && toolCalls.length
      ? toolCallEvents(toolCalls)
      : textEvents(typeof delta.content === 'string' ? delta.content : '');
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n',
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

function textEvents(content: string) {
  return [
    {
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'resp_text',
        object: 'response',
        status: 'in_progress',
        model: 'custom-model',
        output: [],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      sequence_number: 1,
      item: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: content,
      sequence_number: 3,
    },
    {
      type: 'response.output_text.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      text: content,
      sequence_number: 4,
    },
    {
      type: 'response.content_part.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 5,
      part: { type: 'output_text', text: content, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      sequence_number: 6,
      item: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: content, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: {
        id: 'resp_text',
        object: 'response',
        status: 'completed',
        model: 'custom-model',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: content, annotations: [] }],
          },
        ],
      },
    },
  ];
}

function toolCallEvents(
  toolCalls: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
) {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'resp_tools',
        object: 'response',
        status: 'in_progress',
        model: 'custom-model',
        output: [],
      },
    },
  ];
  let sequence = 1;
  const output: Array<Record<string, unknown>> = [];
  for (const [index, call] of toolCalls.entries()) {
    const callId = call.id ?? `call_${index}`;
    const itemId = `fc_${callId}`;
    const name = call.function?.name ?? '';
    const args = call.function?.arguments ?? '{}';
    const item = {
      type: 'function_call',
      id: itemId,
      call_id: callId,
      name,
      arguments: args,
      status: 'completed',
    };
    output.push(item);
    events.push(
      {
        type: 'response.output_item.added',
        output_index: index,
        sequence_number: sequence++,
        item: { ...item, arguments: '', status: 'in_progress' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: itemId,
        output_index: index,
        sequence_number: sequence++,
        delta: args,
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        output_index: index,
        sequence_number: sequence++,
        name,
        arguments: args,
      },
      {
        type: 'response.output_item.done',
        output_index: index,
        sequence_number: sequence++,
        item,
      },
    );
  }
  events.push({
    type: 'response.completed',
    sequence_number: sequence,
    response: {
      id: 'resp_tools',
      object: 'response',
      status: 'completed',
      model: 'custom-model',
      output,
    },
  });
  return events;
}
