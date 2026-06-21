import type { ChatTransport, FileUIPart, UIMessage, UIMessageChunk } from 'ai';
import type { Message, MessageAttachment } from '@/lib/types';

export type ChutesChatConfig = {
  model?: string;
  toolsEnabled?: boolean;
  includeImages?: boolean;
};

type ChutesChatTransportOptions = {
  getConfig?: () => ChutesChatConfig;
};

export type ChutesMessageMetadata = {
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
    memory: {
      input: {
        action: 'add' | 'replace' | 'remove';
        target: 'memory' | 'user';
        content?: string;
        old_text?: string;
      };
      output: unknown;
    };
  }
>;

const TOOL_CALLS_SECTION_MARKER = '<|tool_calls_section_begin|>';

export class ChutesChatTransport implements ChatTransport<ChutesUIMessage> {
  constructor(private readonly options: ChutesChatTransportOptions = {}) {}

  async sendMessages({
    messages,
    abortSignal,
    body,
    metadata,
  }: Parameters<ChatTransport<ChutesUIMessage>['sendMessages']>[0]) {
    const config = resolveChutesChatConfig(this.options.getConfig?.(), metadata, body);
    const isToolResultContinuation =
      messages.length > 0 &&
      messages[messages.length - 1]!.role === 'assistant' &&
      messages[messages.length - 1]!.parts?.some(
        (part: any) =>
          part.type === 'tool-result' ||
          (part.type?.startsWith('tool-') &&
            (part.state === 'output-available' ||
             part.state === 'output-error' ||
             part.state === 'output-denied')),
      );
    const selectedModel = config.model;
    if (!selectedModel) {
      throw new Error('No Chutes model selected. Wait for model discovery to finish, then choose a model.');
    }

    const toolsEnabled = config.toolsEnabled !== false && !isToolResultContinuation;
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
    let disposeAbort: (() => void) | undefined;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const safeEnqueue = (chunk: UIMessageChunk) => {
          if (!closed) controller.enqueue(chunk);
        };

        safeEnqueue({ type: 'start-step' });

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
          emitText(flushBufferedTextToolContent({
            get buffer() {
              return templateToolBuffer;
            },
            set buffer(value: string) {
              templateToolBuffer = value;
            },
          }));

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

          safeEnqueue({ type: 'finish-step' });

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
            if (parsed.error) {
              const message = typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error?.message || JSON.stringify(parsed.error);
              closed = true;
              cleanup();
              controller.error(new Error(message || 'Chutes stream failed.'));
              return;
            }

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

        const handleAbort = () => {
          if (!closed) window.chutes.abort(requestId);
        };

        abortSignal?.addEventListener('abort', handleAbort, { once: true });
        disposeAbort = () => abortSignal?.removeEventListener('abort', handleAbort);

        window.chutes.chat(requestId, {
          model: selectedModel,
          messages: toChutesMessages(messages, { ...config, toolsEnabled }),
          stream: true,
          ...(toolsEnabled ? { tools: buildStandardTools(), tool_choice: 'auto' } : {}),
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
          disposeAbort?.();
        }
      },
      cancel() {
        if (!closed) {
          closed = true;
          window.chutes.abort(requestId);
          disposeChunk?.();
          disposeError?.();
          disposeAbort?.();
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
        name: 'memory',
        description: (
          'Save, update, or remove durable information to persistent memory that survives across sessions.\n\n' +
          'WHEN TO SAVE (proactive — do not wait to be asked):\n' +
          '- User corrects you or says "remember this" / "don\'t do that again"\n' +
          '- User shares a preference, habit, or personal detail (name, role, coding style)\n' +
          '- You discover something about the environment (OS, installed tools, project structure)\n' +
          '- You identify a stable fact that will be useful again in future sessions\n\n' +
          'PRIORITY: User preferences and corrections > environment facts > procedural knowledge.\n' +
          'SKIP: trivial info, things easily re-discovered, raw data dumps, and temporary task state.\n\n' +
          'TWO TARGETS:\n' +
          '- "user": user profile — name, role, preferences, communication style\n' +
          '- "memory": your notes — environment facts, project conventions, lessons learned'
        ),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['add', 'replace', 'remove'],
              description: 'The action to perform.',
            },
            target: {
              type: 'string',
              enum: ['memory', 'user'],
              description: "Which store: 'memory' for agent notes, 'user' for user profile.",
            },
            content: {
              type: 'string',
              description: "The entry content. Required for 'add' and 'replace'.",
            },
            old_text: {
              type: 'string',
              description: "Short unique substring identifying the entry to replace or remove.",
            },
          },
          required: ['action', 'target'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: (
          'Search the live web for current or source-backed information. ' +
          'Returns titles, URLs, snippets, and, when deep search is enabled, bounded page text from top results. ' +
          'Use this when the user asks for recent, changing, or fact-specific information that your training cutoff does not cover.'
        ),
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

function resolveChutesChatConfig(
  defaults: unknown,
  metadata: unknown,
  body: unknown,
): ChutesChatConfig {
  return {
    ...readChutesChatConfig(defaults),
    ...readChutesChatConfig(metadata),
    ...readChutesChatConfig(body),
  };
}

function readChutesChatConfig(value: unknown): ChutesChatConfig {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const source =
    record.custom && typeof record.custom === 'object'
      ? (record.custom as Record<string, unknown>)
      : record;

  return {
    ...(typeof source.model === 'string' ? { model: source.model } : {}),
    ...(typeof source.toolsEnabled === 'boolean' ? { toolsEnabled: source.toolsEnabled } : {}),
    ...(typeof source.includeImages === 'boolean' ? { includeImages: source.includeImages } : {}),
  };
}

function toChutesMessages(messages: ChutesUIMessage[], config: ChutesChatConfig): ChatApiMessage[] {
  const apiMessages: ChatApiMessage[] = [];
  const hasToolOutputs = hasToolOutputParts(messages);

  // toolsEnabled is already resolved by sendMessages, which defensively disables
  // tools on tool-result continuations. Trust that computed value here.
  const toolsEnabled = config.toolsEnabled !== false;

  if (toolsEnabled) {
    apiMessages.push({
      role: 'system',
      content:
        `Current date: ${new Date().toISOString()}.\n` +
        'You have access to the web_search tool. Use it autonomously when the user asks for live, recent, source-backed, or changing information such as weather, news, prices, current events, or schedules. ' +
        'Use at most one web_search call per user request, then answer directly from the returned role:tool results. ' +
        'Do not call web_search again to verify, refine, or repeat the same search unless the user explicitly asks for another search.',
    });
  } else if (hasToolOutputs) {
    apiMessages.push({
      role: 'system',
      content:
        `Current date: ${new Date().toISOString()}.\n` +
        'You have already received tool results for this user request. Do not request, simulate, or write another tool call. Answer directly and concisely from the provided role:tool results.',
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

function hasToolOutputParts(messages: ChutesUIMessage[]) {
  return messages.some((message) =>
    message.role === 'assistant' &&
    collectToolParts(message.parts).some((part) =>
      part.state === 'output-available' ||
      part.state === 'output-error' ||
      part.state === 'output-denied',
    ),
  );
}

function userMessageContent(message: ChutesUIMessage, config: ChutesChatConfig): string | ChutesMessageContentPart[] {
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
  if (state.buffer.startsWith(TOOL_CALLS_SECTION_MARKER)) {
    state.buffer += content;
    return '';
  }

  const combined = state.buffer + content;
  const markerIndex = combined.indexOf(TOOL_CALLS_SECTION_MARKER);
  if (markerIndex !== -1) {
    state.buffer = combined.slice(markerIndex);
    return combined.slice(0, markerIndex);
  }

  const pendingLength = getMarkerPrefixSuffixLength(combined, TOOL_CALLS_SECTION_MARKER);
  if (pendingLength === 0) {
    state.buffer = '';
    return combined;
  }

  state.buffer = combined.slice(-pendingLength);
  return combined.slice(0, -pendingLength);
}

function flushBufferedTextToolContent(state: { buffer: string }) {
  if (!state.buffer || state.buffer.startsWith(TOOL_CALLS_SECTION_MARKER)) return '';
  const text = state.buffer;
  state.buffer = '';
  return text;
}

function getMarkerPrefixSuffixLength(value: string, marker: string) {
  const maxLength = Math.min(value.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
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
  if (!content.includes(TOOL_CALLS_SECTION_MARKER)) return { toolCalls };

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
