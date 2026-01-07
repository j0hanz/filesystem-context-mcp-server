import { type EventLoopUtilization, performance } from 'node:perf_hooks';

export function captureEventLoopUtilization(): EventLoopUtilization {
  return performance.eventLoopUtilization();
}

export function diffEventLoopUtilization(
  start: EventLoopUtilization
): EventLoopUtilization {
  return performance.eventLoopUtilization(start);
}
