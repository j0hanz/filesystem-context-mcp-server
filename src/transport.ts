// Facade for the transport layer, preserving the package's `./transport`
// export and existing import paths. The hosting itself lives in
// `transport/stdio.ts` (pinned-instance stdio serving) and `transport/http.ts`
// (per-request HTTP hosting); `transport/shared.ts` holds the pieces both
// legs gate on.
export type { RuntimeConfig } from './transport/shared.js';
export { listenSubscriptionUris } from './transport/shared.js';
export { seedRootsFromClient, startServer } from './transport/stdio.js';
export { startHttpServer } from './transport/http.js';
