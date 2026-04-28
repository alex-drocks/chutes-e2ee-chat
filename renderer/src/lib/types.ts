export interface MessageStatus {
  done: boolean;
  action: string;
  description: string;
  timestamp: number;
  level?: 'info' | 'warning' | 'error' | 'success';
}

export interface MessageMemory {
  source: 'recalled' | 'saved';
  label: string;
  content: string;
  id: string;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'unsupported';
  text?: string;
  dataUrl?: string;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: MessageAttachment[];
  reasoning?: string;
  isStreaming?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
  done?: boolean;
  statusHistory?: MessageStatus[];
  memoryContext?: MessageMemory[];
  recoveredFromError?: boolean;
  modelUsed?: string;
}
