export interface DiagnosticsEnvSnapshot {
  diagnostics?: string;
  diagnosticsDetail?: string;
}

const restoreEnv = (key: string, previous: string | undefined): void => {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = previous;
};

export function enableDiagnosticsEnv(): DiagnosticsEnvSnapshot {
  const previousEnabled = process.env.FS_CONTEXT_DIAGNOSTICS;
  const previousDetail = process.env.FS_CONTEXT_DIAGNOSTICS_DETAIL;
  process.env.FS_CONTEXT_DIAGNOSTICS = '1';
  process.env.FS_CONTEXT_DIAGNOSTICS_DETAIL = '0';
  return {
    diagnostics: previousEnabled,
    diagnosticsDetail: previousDetail,
  };
}

export function restoreDiagnosticsEnv(snapshot: DiagnosticsEnvSnapshot): void {
  restoreEnv('FS_CONTEXT_DIAGNOSTICS', snapshot.diagnostics);
  restoreEnv('FS_CONTEXT_DIAGNOSTICS_DETAIL', snapshot.diagnosticsDetail);
}
