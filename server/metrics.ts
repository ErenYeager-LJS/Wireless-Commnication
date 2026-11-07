import type { Health, LinkMetric, NodeState } from '../src/types.js';

export function lossPercent(metric: LinkMetric | null): number {
  if (!metric || metric.sent === 0) return 0;
  return Math.max(0, ((metric.sent - metric.received) / metric.sent) * 100);
}

export function deriveHealth(
  nodes: NodeState[],
  metric: LinkMetric | null,
  degradedRttMs: number,
  degradedLossPercent: number,
): Health {
  if (!nodes.length) return 'unknown';
  if (nodes.some((node) => !node.online)) return 'offline';
  if (!metric) return 'unknown';
  if (metric.rttP95Ms >= degradedRttMs || lossPercent(metric) >= degradedLossPercent) return 'degraded';
  return 'normal';
}

export function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}
