import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Chat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { ChutesChatTransport, type ChutesUIMessage } from '../src/lib/ai/chutesTransport';
import { ToolResultScope } from '../src/lib/ai/toolResultScope';
import type {} from '../src/types/chutes';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function mockBridge(respond?: (requestId: string, callIndex: number) => void) {
  const chunks = new Set<Parameters<Window['chutes']['onStreamChunk']>[0]>();
  const errors = new Set<Parameters<Window['chutes']['onStreamError']>[0]>();
  const calls: Parameters<Window['chutes']['chat']>[] = [];
  const aborts: string[] = [];
  const started = Promise.withResolvers<void>();
  const chutes = {
    onStreamChunk(callback: Parameters<Window['chutes']['onStreamChunk']>[0]) {
      chunks.add(callback);
      return () => { chunks.delete(callback); };
    },
    onStreamError(callback: Parameters<Window['chutes']['onStreamError']>[0]) {
      errors.add(callback);
      return () => { errors.delete(callback); };
    },
    async chat(...args: Parameters<Window['chutes']['chat']>) {
      calls.push(args);
      started.resolve();
      respond?.(args[0], calls.length - 1);
      return { ok: true, stream: true };
    },
    async abort(requestId: string) {
      aborts.push(requestId);
      return { ok: true };
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chutes } });
  return {
    calls,
    aborts,
    started: started.promise,
    delta(requestId: string, delta: Record<string, unknown>) {
      for (const callback of chunks) callback({ requestId, data: JSON.stringify({ choices: [{ delta }] }) });
    },
    finish(requestId: string) {
      for (const callback of chunks) callback({ requestId, done: true });
    },
    error(requestId: string, error: string) {
      for (const callback of errors) callback({ requestId, error });
    },
    get listeners() { return chunks.size + errors.size; },
  };
}

function transport() {
  return new ChutesChatTransport({ getConfig: () => ({ model: 'test-TEE', toolsEnabled: true }) });
}

test('AI SDK consumes streamed text and reasoning from the IPC transport', async () => {
  const bridge = mockBridge((id) => {
    bridge.delta('unrelated-request', { content: 'must be ignored' });
    bridge.delta(id, { reasoning_content: 'Checking encryption.' });
    bridge.delta(id, { content: 'Hello ' });
    bridge.delta(id, { content: '**world**.' });
    bridge.finish(id);
  });
  const chat = new Chat<ChutesUIMessage>({ transport: transport() });

  await chat.sendMessage({ text: 'Hello' });

  assert.equal(chat.status, 'ready');
  assert.equal(chat.error, undefined);
  assert.equal(chat.messages.length, 2);
  const parts = chat.messages[1]!.parts;
  assert.deepEqual(parts.filter(p => p.type === 'text').map(p => p.text), ['Hello **world**.']);
  assert.deepEqual(parts.filter(p => p.type === 'reasoning').map(p => p.text), ['Checking encryption.']);
  assert.equal(bridge.calls[0]![1].model, 'test-TEE');
  assert.ok(bridge.calls[0]![1].messages.some(m => m.role === 'user' && m.content === 'Hello'));
  assert.equal(bridge.listeners, 0);
});

test('AI SDK completes a fragmented tool call and sends its result in the next turn', async () => {
  const bridge = mockBridge((id, index) => {
    if (index === 0) {
      bridge.delta(id, { tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{"query":' } }] });
      bridge.delta(id, { tool_calls: [{ index: 0, function: { arguments: '"Bun releases"}' } }] });
    } else {
      bridge.delta(id, { content: 'The search completed.' });
    }
    bridge.finish(id);
  });
  const output = { results: [{ sourceId: 'S1', title: 'Bun', url: 'https://bun.sh', snippet: 'Release details' }] };
  const chat = new Chat<ChutesUIMessage>({
    transport: transport(),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: ({ toolCall }) => {
      assert.equal(toolCall.toolName, 'web_search');
      assert.deepEqual(toolCall.input, { query: 'Bun releases' });
      void chat.addToolOutput({ tool: 'web_search', toolCallId: toolCall.toolCallId, output });
    },
  });

  await chat.sendMessage({ text: 'Find the Bun release notes' });

  assert.equal(chat.status, 'ready');
  assert.equal(chat.error, undefined);
  assert.equal(bridge.calls.length, 2);
  const continuation = bridge.calls[1]![1];
  const toolResult = continuation.messages.find(m => m.role === 'tool');
  assert.equal(toolResult?.tool_call_id, 'search-1');
  assert.ok(String(toolResult?.content).includes('Release details'));
  assert.equal(continuation.tools, undefined);
  assert.ok(chat.messages.at(-1)!.parts.some(p => p.type === 'text' && p.text === 'The search completed.'));
  assert.equal(bridge.listeners, 0);
});

test('AI SDK surfaces IPC errors and removes stream listeners', async () => {
  const bridge = mockBridge(id => bridge.error(id, 'Encrypted request failed'));
  const chat = new Chat<ChutesUIMessage>({ transport: transport() });

  await chat.sendMessage({ text: 'Hello' });

  assert.equal(chat.status, 'error');
  assert.equal(chat.error?.message, 'Encrypted request failed');
  assert.equal(bridge.listeners, 0);
});

test('stopping an AI SDK chat aborts its IPC request and releases listeners', async () => {
  const bridge = mockBridge();
  const chat = new Chat<ChutesUIMessage>({ transport: transport() });
  const sending = chat.sendMessage({ text: 'Hello' });
  await bridge.started;

  await chat.stop();
  await sending;

  assert.equal(chat.status, 'ready');
  assert.deepEqual(bridge.aborts, [bridge.calls[0]![0]]);
  assert.equal(bridge.listeners, 0);
});

for (const outcome of ['success', 'error'] as const) {
  test(`a stopped chat ignores a delayed tool ${outcome}`, async () => {
    const scope = new ToolResultScope();
    const toolStarted = Promise.withResolvers<void>();
    const toolFinished = Promise.withResolvers<void>();
    const bridge = mockBridge((id, index) => {
      if (index === 0) {
        bridge.delta(id, { tool_calls: [{ index: 0, id: 'slow-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }] });
      } else {
        bridge.delta(id, { content: 'This request should never start.' });
      }
      bridge.finish(id);
    });
    const chat = new Chat<ChutesUIMessage>({
      transport: transport(),
      sendAutomaticallyWhen: options => scope.active && lastAssistantMessageIsCompleteWithToolCalls(options),
      onToolCall: async ({ toolCall }) => {
        const submit = scope.bind(chat.addToolOutput);
        toolStarted.resolve();
        await toolFinished.promise;
        // Do not await addToolOutput inside onToolCall: the SDK serializes these jobs.
        void submit({
          tool: 'web_search', toolCallId: toolCall.toolCallId,
          ...(outcome === 'success'
            ? { output: { ok: true, results: [] } }
            : { state: 'output-error' as const, errorText: 'Search failed' }),
        });
      },
    });
    scope.begin();
    const sending = chat.sendMessage({ text: 'Search' });
    await toolStarted.promise;

    scope.cancel();
    await chat.stop();
    toolFinished.resolve();
    await sending;
    // Drain the SDK's queued addToolOutput/automatic continuation work too.
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(bridge.calls.length, 1);
    assert.equal(chat.status, 'ready');
    assert.equal(chat.error, undefined);
    const tool = chat.messages.at(-1)?.parts.find(p => p.type === 'tool-web_search');
    assert.equal(tool?.state, 'input-available');
    assert.equal(bridge.listeners, 0);
  });
}

test('a new chat cannot accept a delayed result from the previous run', async () => {
  const scope = new ToolResultScope();
  const toolStarted = Promise.withResolvers<void>();
  const toolFinished = Promise.withResolvers<void>();
  const bridge = mockBridge((id, index) => {
    if (index === 0) {
      bridge.delta(id, { tool_calls: [{ index: 0, id: 'old-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"old"}' } }] });
    } else {
      bridge.delta(id, { content: 'Fresh answer.' });
    }
    bridge.finish(id);
  });
  const chat = new Chat<ChutesUIMessage>({
    transport: transport(),
    sendAutomaticallyWhen: options => scope.active && lastAssistantMessageIsCompleteWithToolCalls(options),
    onToolCall: async ({ toolCall }) => {
      const submit = scope.bind(chat.addToolOutput);
      toolStarted.resolve();
      await toolFinished.promise;
      void submit({ tool: 'web_search', toolCallId: toolCall.toolCallId, output: { stale: true } });
    },
  });
  scope.begin();
  const oldSending = chat.sendMessage({ text: 'Old search' });
  await toolStarted.promise;

  scope.cancel();
  await chat.stop();
  chat.messages = [];
  scope.begin();
  const newSending = chat.sendMessage({ text: 'New question' });
  toolFinished.resolve();
  await Promise.all([oldSending, newSending]);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(bridge.calls.length, 2);
  assert.equal(chat.error, undefined);
  assert.equal(chat.status, 'ready');
  assert.equal(chat.messages.length, 2);
  assert.deepEqual(chat.messages[0]?.parts, [{ type: 'text', text: 'New question' }]);
  assert.ok(chat.messages[1]?.parts.some(p => p.type === 'text' && p.text === 'Fresh answer.'));
  assert.ok(chat.messages.every(m => m.parts.every(p => p.type !== 'tool-web_search')));
  assert.equal(bridge.listeners, 0);
});

test('an active chat still continues after an asynchronous tool completes', async () => {
  const scope = new ToolResultScope();
  const bridge = mockBridge((id, index) => {
    if (index === 0) {
      bridge.delta(id, { tool_calls: [{ index: 0, id: 'active-search', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }] });
    } else {
      bridge.delta(id, { content: 'Search answer.' });
    }
    bridge.finish(id);
  });
  const chat = new Chat<ChutesUIMessage>({
    transport: transport(),
    sendAutomaticallyWhen: options => scope.active && lastAssistantMessageIsCompleteWithToolCalls(options),
    onToolCall: async ({ toolCall }) => {
      const submit = scope.bind(chat.addToolOutput);
      await new Promise(resolve => setTimeout(resolve, 0));
      void submit({ tool: 'web_search', toolCallId: toolCall.toolCallId, output: { ok: true } });
    },
  });
  scope.begin();

  await chat.sendMessage({ text: 'Search' });

  assert.equal(bridge.calls.length, 2);
  assert.equal(chat.status, 'ready');
  assert.equal(chat.error, undefined);
  assert.ok(chat.messages.at(-1)?.parts.some(p => p.type === 'text' && p.text === 'Search answer.'));
  assert.equal(bridge.listeners, 0);
});

test('an already aborted request never starts IPC', async () => {
  const bridge = mockBridge();
  const controller = new AbortController();
  controller.abort();
  const stream = await transport().sendMessages({
    chatId: 'aborted-chat', trigger: 'submit-message', messageId: undefined,
    messages: [], abortSignal: controller.signal,
  });

  await assert.rejects(stream.getReader().read(), { name: 'AbortError' });
  assert.equal(bridge.calls.length, 0);
  assert.equal(bridge.listeners, 0);
});

test('AI SDK preserves malformed tool inputs as tool errors', async () => {
  const bridge = mockBridge(id => {
    bridge.delta(id, { tool_calls: [{ index: 0, id: 'invalid-tool', type: 'function', function: { name: 'web_search', arguments: '{broken' } }] });
    bridge.finish(id);
  });
  const chat = new Chat<ChutesUIMessage>({ transport: transport() });

  await chat.sendMessage({ text: 'Search' });

  assert.equal(chat.status, 'ready');
  const tool = chat.messages.at(-1)!.parts.find(p => p.type === 'tool-web_search');
  assert.ok(tool?.state === 'output-error');
  assert.equal(tool.errorText, 'Tool arguments were not valid JSON.');
  assert.equal(bridge.listeners, 0);
});
