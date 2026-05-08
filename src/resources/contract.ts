import type {
  ReadResourceResult,
  ServerContext,
} from '@modelcontextprotocol/server';

export interface ResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;

  uri?: string;
  uriTemplate?: string;

  annotations?: {
    audience?: ('user' | 'assistant')[];
    priority?: number;
  };

  read: (
    uri: URL,
    variables: Record<string, string>,
    ctx: ServerContext
  ) => Promise<ReadResourceResult> | ReadResourceResult;
  complete?: (
    variable: string,
    value: string,
    ctx?: { arguments?: Record<string, string> }
  ) => Promise<string[]> | string[];

  subscribe?: (uri: string, notify: (uri: string) => void) => void;
  unsubscribe?: (uri: string) => void;
  /** Global teardown hook to clean up watchers/timers */
  destroy?: () => void;
}
