import type { CommandRecord, RouteMode, Snapshot } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(40_000),
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `HTTP ${response.status}`);
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export const api = {
  snapshot: () => request<Snapshot>('/api/snapshot'),
  setMode: (mode: RouteMode) => request<unknown>('/api/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  camera: (enabled: boolean) => request<unknown>('/api/esp/camera', {method: 'POST', body: JSON.stringify({enabled})}),
  detection: (enabled: boolean) => request<unknown>('/api/esp/detection', {method: 'POST', body: JSON.stringify({enabled})}),
  command: (action: CommandRecord['action'], target = 'TERM-01') =>
    request<CommandRecord>('/api/commands', { method: 'POST', body: JSON.stringify({ action, target }) }),
  scenario: (scenario: Snapshot['demoScenario']) =>
    request<{ ok: boolean }>('/api/demo/scenario', { method: 'POST', body: JSON.stringify({ scenario }) }),
};
