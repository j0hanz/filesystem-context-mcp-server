import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
} from '../lib/errors.js';

function buildContentBlock<T>(
  text: string,
  structuredContent: T
): { content: { type: 'text'; text: string }[]; structuredContent: T } {
  const json = JSON.stringify(structuredContent);
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: json },
    ],
    structuredContent,
  };
}

function resolveDetailedError(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): ReturnType<typeof createDetailedError> {
  const detailed = createDetailedError(error, path);
  if (detailed.code === ErrorCode.E_UNKNOWN) {
    detailed.code = defaultCode;
    detailed.suggestion = getSuggestion(defaultCode);
  }
  return detailed;
}

export function buildToolResponse<T>(
  text: string,
  structuredContent: T
): {
  content: { type: 'text'; text: string }[];
  structuredContent: T;
} {
  return buildContentBlock(text, structuredContent);
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
  const detailed = resolveDetailedError(error, defaultCode, path);
  const text = formatDetailedError(detailed);

  const structuredContent: ToolErrorStructuredContent = {
    ok: false,
    error: {
      code: detailed.code,
      message: detailed.message,
      path: detailed.path,
      suggestion: detailed.suggestion,
    },
  };
  return {
    ...buildContentBlock(text, structuredContent),
    isError: true,
  };
}
