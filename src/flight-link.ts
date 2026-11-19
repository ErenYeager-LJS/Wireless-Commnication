import type { LinkMode, ReceiverStatus } from './types.js';

export type Position3 = [number, number, number];
export const FLIGHT_HEIGHT = 18;
export const FLIGHT_SPEED = 4;
export interface OrbitState {x: number; z: number; radius: number; angle: number}

export function orbitPosition(orbit: OrbitState): Position3 {
  return [orbit.x + Math.cos(orbit.angle) * orbit.radius, FLIGHT_HEIGHT,
    orbit.z + Math.sin(orbit.angle) * orbit.radius];
}

export function advanceOrbit(previous: OrbitState, target: {center: Position3; radius: number}, delta: number): OrbitState {
  const dt = Math.max(0, Math.min(delta, .1));
  const blend = 1 - Math.exp(-dt * 2.5);
  const radius = previous.radius + (target.radius - previous.radius) * blend;
  return {x: previous.x + (target.center[0] - previous.x) * blend,
    z: previous.z + (target.center[2] - previous.z) * blend, radius,
    angle: (previous.angle + FLIGHT_SPEED / radius * dt) % (Math.PI * 2)};
}

// These are scene coordinates, never metres or measured aircraft coordinates.
export function flightAnchors(exploded = false): {relay: Position3; receiver: Position3} {
  return {relay: [0, 7.9 + (exploded ? 3.25 : 0), -1], receiver: [14, 4.3 + (exploded ? 1.3 : 0), -10]};
}

export function flightSignal(video?: ReceiverStatus | null) {
  const online = !!(video?.online && video.enabled);
  const rssi = online && Number.isFinite(video?.rssi) && video!.rssi! < 0 && video!.rssi! >= -127 ? video!.rssi! : null;
  const route: LinkMode = video?.route === 'relay' ? 'relay' : 'direct';
  // Continuous mapping retains changes in strong signals such as -33 / -35 dBm.
  // Scene units only: no uncalibrated conversion to a distance in metres.
  const radius = rssi === null ? 16 : 3 + 32 / (1 + Math.exp((rssi + 58) / 12));
  const center = route === 'relay' ? flightAnchors().relay : flightAnchors().receiver;
  return {online, route, rssi, radius, center,
    reference: route === 'relay' ? '中继器 RSSI' : '主路由 RSSI',
    path: route === 'relay' ? '无人机 → 中继站 → 接收中心' : '无人机 → 接收中心'};
}
