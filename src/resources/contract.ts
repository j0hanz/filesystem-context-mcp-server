export interface ResourceSubscriptionLifecycle {
  onSubscribe(uri: string): void;
  onUnsubscribe(uri: string): void;
  destroy(): void;
}

export interface ResourceContract {
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Fixed URI for static resources, e.g. 'internal://instructions'. */
  uri?: string;
  /** Human-readable template string for template-based resources, e.g. 'filesystem-mcp://file/{+path}'. */
  uriTemplate?: string;
  annotations: {
    audience: ('user' | 'assistant')[];
    priority: number;
  };
  /** Present only on resources that push updates (metrics, filesystem-file). */
  createSubscription?: (
    notify: (uri: string) => void
  ) => ResourceSubscriptionLifecycle;
}
