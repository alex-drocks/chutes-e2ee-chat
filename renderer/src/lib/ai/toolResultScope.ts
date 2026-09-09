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

  bind(submit: AddToolOutput): AddToolOutput {
    const { signal } = this.controller;
    return (output) => {
      if (!signal.aborted) return submit(output);
    };
  }
}
