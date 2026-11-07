import assert from 'node:assert/strict';
import test from 'node:test';
import type { LinkMetric, NodeState } from '../src/types.js';
import { deriveHealth, lossPercent, percentile95 } from '../server/metrics.js';

const metric: LinkMetric = {
  timestamp: new Date(0).toISOString(), testId: 'T1', sourceNode: 'A', targetNode: 'B', path: ['A', 'B'],
  windowSeconds: 1, sent: 100, received: 98, timedOut: 2, duplicates: 0, rttAvgMs: 40, rttP95Ms: 80,
  goodputKbps: 100, forwardedPackets: 0, source: 'measured',
};
const nodes: NodeState[] = [{
  nodeId: 'A', role: 'terminal', online: true, sequence: 1, mode: 'direct', upstream: 'B', downstream: null,
  lastSeen: new Date(0).toISOString(), source: 'measured',
}];

test('calculates packet loss from sent and received', () => assert.equal(lossPercent(metric), 2));
test('computes p95 without averaging away spikes', () => assert.equal(percentile95([1, 2, 3, 4, 100]), 100));
test('classifies healthy, degraded and offline links', () => {
  assert.equal(deriveHealth(nodes, metric, 120, 5), 'normal');
  assert.equal(deriveHealth(nodes, { ...metric, rttP95Ms: 130 }, 120, 5), 'degraded');
  assert.equal(deriveHealth([{ ...nodes[0], online: false }], metric, 120, 5), 'offline');
});
