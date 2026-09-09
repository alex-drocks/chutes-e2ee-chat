import type { ChatAddToolOutputFunction } from 'ai';
import type { ChutesUIMessage } from './chutesTransport';

type AddToolOutput = ChatAddToolOutputFunction<ChutesUIMessage>;

/** Keeps asynchronous tool results attached to the chat run that started them. */
export class ToolResultScope {
  private controller = new AbortController();

  get active() {
    return !this.controller.signal.aborted;
  }

  begin() {
    this.cancel();
    this.controller = new AbortController();
  }

  cancel() {
    this.controller.abort();
  }

  /** Release the SDK's tool handler on Stop, even if its IPC work is still pending. */
  async waitFor<T>(operation: Promise<T>): Promise<T | undefined> {
    const { signal } = this.controller;
    let cleanup = () => {};
    const cancelled = new Promise<undefined>((resolve) => {
      const onAbort = () => resolve(undefined);
      cleanup = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      cleanup();
    }
  }

  bind(submit: AddToolOutput): AddToolOutput {
    const { signal } = this.controller;
    return (output) => {
      if (!signal.aborted) return submit(output);
    };
  }
}
