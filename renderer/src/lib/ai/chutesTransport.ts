import type { ChatTransport, FileUIPart, UIMessage, UIMessageChunk } from 'ai';
import type { Message, MessageAttachment } from '@/lib/types';

type ChutesChatBody = {
  model?: string;
  toolsEnabled?: boolean;
  includeImages?: boolean;
};

type ChutesMessageMetadata = {
  attachments?: MessageAttachment[];
  memoryContext?: Message['memoryContext'];
  memoryContextText?: string;
};

type ChatApiMessage = {
  role: string;
  content?: string | ChutesMessageContentPart[] | null;
  tool_calls?: ChutesToolCall[];
  tool_call_id?: string;
  name?: string;
};

type PendingToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ChutesUIMessage = UIMessage<
  ChutesMessageMetadata,
  Record<string, never>,
  {
    web_search: {
      input: { query: string };
      output: unknown;
    };
  }
>;

const DEFAULT_MODEL = 'Qwen/Qwen3-32B-TEE';

export class ChutesChatTransport implements ChatTransport<ChutesUIMessage> {
  async sendMessages({
    messages,
    abortSignal,
    body,
  }: Parameters<ChatTransport<ChutesUIMessage>['sendMessages']>[0]) {
    const config = (body || {}) as ChutesChatBody;
    const requestId = crypto.randomUUID();
    const textId = `text-${requestId}`;
    const reasoningId = `reasoning-${requestId}`;
    const pendingToolCalls = new Map<number, PendingToolCall>();
    let textStarted = false;
    let reasoningStarted = false;
    let templateToolBuffer = '';
    let closed = false;
    let disposeChunk: (() => void) | undefined;
    let disposeError: (() => void) | undefined;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const safeEnqueue = (chunk: UIMessageChunk) => {
          if (!closed) controller.enqueue(chunk);
        };

        const startText = () => {
          if (!textStarted) {
            textStarted = true;
            safeEnqueue({ type: 'text-start', id: textId });
          }
        };

        const emitText = (text: string) => {
          if (!text) return;
          startText();
          safeEnqueue({ type: 'text-delta', id: textId, delta: text });
        };

        const startReasoning = () => {
          if (!reasoningStarted) {
            reasoningStarted = true;
            safeEnqueue({ type: 'reasoning-start', id: reasoningId });
          }
        };

        const emitReasoning = (reasoning: string) => {
          if (!reasoning) return;
          startReasoning();
          safeEnqueue({ type: 'reasoning-delta', id: reasoningId, delta: reasoning });
        };

        const finish = () => {
          const textToolCalls = extractTextToolCalls(templateToolBuffer);
          queuePendingToolCalls(textToolCalls.toolCalls, pendingToolCalls);
          templateToolBuffer = '';

          if (textStarted) safeEnqueue({ type: 'text-end', id: textId });
          if (reasoningStarted) safeEnqueue({ type: 'reasoning-end', id: reasoningId });

          const toolCalls = Array.from(pendingToolCalls.values())
            .filter((toolCall) => toolCall.id && toolCall.function.name)
            .map((toolCall) => ({
              ...toolCall,
              function: {
                ...toolCall.function,
                name: normalizeToolName(toolCall.function.name),
              },
            }));

          for (const toolCall of toolCalls) {
            const toolName = normalizeToolName(toolCall.function.name);
            try {
              safeEnqueue({
                type: 'tool-input-available',
                toolCallId: toolCall.id,
                toolName,
                input: JSON.parse(toolCall.function.arguments || '{}'),
              });
            } catch {
              safeEnqueue({
                type: 'tool-input-error',
                toolCallId: toolCall.id,
                toolName,
                input: toolCall.function.arguments,
                errorText: 'Tool arguments were not valid JSON.',
              });
            }
          }

          safeEnqueue({
            type: 'finish',
            finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
          });
          closed = true;
          cleanup();
          controller.close();
        };

        disposeChunk = window.chutes.onStreamChunk((payload) => {
          if (payload.requestId !== requestId || closed) return;
          if (payload.done) {
            finish();
            return;
          }
          if (!payload.data || payload.data === '[DONE]') return;

          try {
            const parsed = JSON.parse(payload.data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) return;

            const content = String(delta.content || '');
            const visibleContent = bufferTextToolContent(content, {
              get buffer() {
                return templateToolBuffer;
              },
              set buffer(value: string) {
                templateToolBuffer = value;
              },
            });

            emitText(visibleContent);
            emitReasoning(String(delta.reasoning_content || delta.reasoning || ''));

            if (Array.isArray(delta.tool_calls)) {
              accumulateToolCallDeltas(delta.tool_calls, pendingToolCalls);
            }
          } catch (err: any) {
            safeEnqueue({ type: 'error', errorText: err?.message || 'Could not parse stream chunk.' });
          }
        });

        disposeError = window.chutes.onStreamError((payload) => {
          if (payload.requestId !== requestId || closed) return;
          closed = true;
          cleanup();
          controller.error(new Error(payload.error || 'Chutes stream failed.'));
        });

        abortSignal?.addEventListener('abort', () => {
          if (!closed) window.chutes.abort(requestId);
        }, { once: true });

        window.chutes.chat(requestId, {
          model: config.model || DEFAULT_MODEL,
          messages: toChutesMessages(messages, config),
          stream: true,
          ...(config.toolsEnabled ? { tools: buildStandardTools(), tool_choice: 'auto' } : {}),
        }).then((res) => {
          if (!res.ok && !closed) {
            closed = true;
            cleanup();
            controller.error(new Error(res.error || 'Chutes request failed.'));
          }
        }).catch((err) => {
          if (!closed) {
            closed = true;
            cleanup();
            controller.error(err instanceof Error ? err : new Error(String(err)));
          }
        });

        function cleanup() {
          disposeChunk?.();
          disposeError?.();
        }
      },
      cancel() {
        if (!closed) {
          closed = true;
          window.chutes.abort(requestId);
          disposeChunk?.();
          disposeError?.();
        }
      },
    });
  }

  async reconnectToStream() {
    return null;
  }
}

export function buildStandardTools(): ChutesToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the live web for current or source-backed information. Returns titles, URLs, and snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The web search query to run.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
  ];
}

function toChutesMessages(messages: ChutesUIMessage[], config: ChutesChatBody): ChatApiMessage[] {
  const apiMessages: ChatApiMessage[] = [];
  if (config.toolsEnabled) {
    apiMessages.push({
      role: 'system',
      content:
        `Current date: ${new Date().toISOString()}.\n` +
        'Use web_search when live, recent, source-backed, or changing information is needed. ' +
        'Tool results are fetched by the app from the live web and returned as role:tool messages.',
    });
  }

  for (const message of messages) {
    if (message.role === 'user') {
      apiMessages.push({
        role: 'user',
        content: userMessageContent(message, config),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const text = collectText(message.parts);
      const toolParts = collectToolParts(message.parts);
      apiMessages.push({
        role: 'assistant',
        content: text || (toolParts.length > 0 ? null : ''),
        ...(toolParts.length > 0
          ? {
              tool_calls: toolParts.map((part) => ({
                id: part.toolCallId,
                type: 'function' as const,
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input ?? {}),
                },
              })),
            }
          : {}),
      });

      for (const part of toolParts) {
        if (part.state === 'output-available' || part.state === 'output-error' || part.state === 'output-denied') {
          apiMessages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            name: part.toolName,
            content: JSON.stringify(
              part.state === 'output-available'
                ? part.output
                : { ok: false, error: part.errorText || 'Tool output denied.' },
            ),
          });
        }
      }
    }
  }

  return apiMessages;
}

function userMessageContent(message: ChutesUIMessage, config: ChutesChatBody): string | ChutesMessageContentPart[] {
  const textBlocks = [collectText(message.parts)];
  const metadata = message.metadata;
  const attachments = metadata?.attachments || [];

  for (const attachment of attachments) {
    if (attachment.kind === 'text' && attachment.text) {
      textBlocks.push(`Attached text file: ${attachment.name} (${formatFileSize(attachment.size)})\n\n\`\`\`\n${attachment.text}\n\`\`\``);
    } else if (attachment.kind === 'unsupported') {
      textBlocks.push(`Attached file metadata only: ${attachment.name} (${attachment.mimeType}, ${formatFileSize(attachment.size)}). This app does not extract this file type yet.`);
    }
  }

  const fileParts = message.parts.filter((part): part is FileUIPart => part.type === 'file');
  const imageParts = fileParts.filter((part) => part.mediaType.startsWith('image/'));
  if (imageParts.length > 0 && !config.includeImages) {
    textBlocks.push(`Image attachment note: ${imageParts.map((part) => part.filename || 'image').join(', ')} not sent because the selected model does not advertise image input.`);
  }
  if (metadata?.memoryContextText) textBlocks.push(metadata.memoryContextText);

  const text = textBlocks.filter(Boolean).join('\n\n');
  if (imageParts.length > 0 && config.includeImages) {
    return [
      { type: 'text' as const, text },
      ...imageParts.map((part) => ({
        type: 'image_url' as const,
        image_url: { url: part.url },
      })),
    ];
  }

  return text;
}

function collectText(parts: ChutesUIMessage['parts']) {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

function collectToolParts(parts: ChutesUIMessage['parts']) {
  return parts
    .filter((part) => part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
    .map((part: any) => ({
      toolCallId: String(part.toolCallId),
      toolName: normalizeToolName(part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)),
      input: part.input,
      output: part.output,
      errorText: part.errorText,
      state: part.state,
    }));
}

function bufferTextToolContent(content: string, state: { buffer: string }) {
  if (!content) return '';
  const marker = '<|tool_calls_section_begin|>';
  if (state.buffer) {
    state.buffer += content;
    return '';
  }

  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) return content;

  state.buffer = content.slice(markerIndex);
  return content.slice(0, markerIndex);
}

function accumulateToolCallDeltas(toolCalls: any[], pending: Map<number, PendingToolCall>) {
  for (const delta of toolCalls) {
    const index = Number.isInteger(delta.index) ? delta.index : 0;
    const current = pending.get(index) || {
      id: '',
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };

    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function?.name) current.function.name += String(delta.function.name);
    if (delta.function?.arguments) current.function.arguments += String(delta.function.arguments);

    pending.set(index, current);
  }
}

function extractTextToolCalls(content: string) {
  const toolCalls: PendingToolCall[] = [];
  if (!content.includes('<|tool_calls_section_begin|>')) return { toolCalls };

  let callIndex = 0;
  const sectionPattern = /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g;
  for (const sectionMatch of content.matchAll(sectionPattern)) {
    const section = sectionMatch[0];
    const callPattern = /<\|tool_call_begin\|>\s*([^\s<]+?)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
    for (const callMatch of section.matchAll(callPattern)) {
      toolCalls.push({
        id: `text-tool-${Date.now()}-${callIndex}`,
        type: 'function',
        function: {
          name: normalizeToolName(callMatch[1]),
          arguments: callMatch[2].trim(),
        },
      });
      callIndex += 1;
    }
  }

  return { toolCalls };
}

function queuePendingToolCalls(toolCalls: PendingToolCall[], pending: Map<number, PendingToolCall>) {
  const startIndex = pending.size;
  toolCalls.forEach((toolCall, offset) => {
    pending.set(startIndex + offset, toolCall);
  });
}

function normalizeToolName(name: string) {
  return name.replace(/^functions\./, '').replace(/:\d+$/, '').trim();
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
