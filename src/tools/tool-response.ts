import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
} from '../lib/errors.js';

export function buildToolResponse<T>(
  text: string,
  structuredContent: T
): {
  content: { type: 'text'; text: string }[];
  structuredContent: T;
} {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export type ToolResponse<T> = ReturnType<typeof buildToolResponse<T>>;
type ToolErrorResponse = ReturnType<typeof buildToolErrorResponse>;
export type ToolResult<T> = ToolResponse<T> | ToolErrorResponse;

export async function withToolErrorHandling<T>(
  run: () => Promise<ToolResponse<T>>,
  onError: (error: unknown) => ToolResult<T>
): Promise<ToolResult<T>> {
  try {
    return await run();
  } catch (error) {
    return onError(error);
  }
}

interface ToolErrorStructuredContent extends Record<string, unknown> {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
    suggestion?: string;
  };
}

export function buildToolErrorResponse(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): {
  content: { type: 'text'; text: string }[];
  structuredContent: ToolErrorStructuredContent;
  isError: true;
} {
  const detailed = createDetailedError(error, path);
  if (detailed.code === ErrorCode.E_UNKNOWN) {
    detailed.code = defaultCode;
    detailed.suggestion = getSuggestion(defaultCode);
  }

  const text = formatDetailedError(detailed);

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      ok: false,
      error: {
        code: detailed.code,
        message: detailed.message,
        path: detailed.path,
        suggestion: detailed.suggestion,
      },
    },
    isError: true,
  };
}
