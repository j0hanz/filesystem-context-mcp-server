function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasBooleanOk(value: unknown): value is { ok: boolean } {
  return isObject(value) && typeof value.ok === 'boolean';
}

export function resolveDiagnosticsOk(result: unknown): boolean | undefined {
  if (!isObject(result)) return undefined;
  if (result.isError === true) return false;
  if (hasBooleanOk(result)) return result.ok;

  const structured = result.structuredContent;
  if (hasBooleanOk(structured)) return structured.ok;

  return undefined;
}

function resolvePrimitiveDiagnosticsMessage(
  error: unknown
): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }
  if (typeof error === 'bigint') return error.toString();
  if (typeof error === 'symbol') return error.description ?? 'symbol';
  return undefined;
}

function resolveObjectDiagnosticsMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === 'string') {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
}

export function resolveDiagnosticsErrorMessage(
  error?: unknown
): string | undefined {
  if (error === undefined || error === null) return undefined;
  return (
    resolvePrimitiveDiagnosticsMessage(error) ??
    resolveObjectDiagnosticsMessage(error)
  );
}
