import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceOrbit, FLIGHT_HEIGHT, FLIGHT_SPEED, flightAnchors, flightSignal, orbitPosition } from '../src/flight-link.js';
import type { ReceiverStatus } from '../src/types.js';

const video = (route: 'direct' | 'relay', rssi: number): ReceiverStatus => ({online: true, enabled: true,
  fps: 31, received: 10, age_ms: 0, frame_loss_percent: 0, events: [], route, rssi});

test('strong direct RSSI changes remain visible instead of saturating at -40 dBm', () => {
  const radii = [-30, -33, -35, -40, -65, -85].map(rssi => flightSignal(video('direct', rssi)).radius);
  for (let i=1; i<radii.length; i++) assert.ok(radii[i] > radii[i-1]);
  assert.equal(flightSignal(video('direct', -70)).reference, '主路由 RSSI');
});
test('the orbit is centred on the actual AP and relay RSSI never becomes router distance', () => {
  const relay = flightSignal(video('relay', -40));
  assert.deepEqual(relay.center, flightAnchors().relay);
  assert.deepEqual(flightSignal(video('direct', -40)).center, flightAnchors().receiver);
  assert.equal(relay.reference, '中继器 RSSI');
  assert.equal(relay.route, 'relay');
  assert.equal(flightSignal(video('direct', -85)).route, 'direct'); // Rendering never changes real routing.
});

test('an unchanged radius produces circular flight at constant linear speed across render rates', () => {
  for (const radius of [5, 15, 30]) for (const hz of [20, 60]) {
    let state = {x: 14, z: -10, radius, angle: 0};
    const target = {center: [14, 4.3, -10] as [number,number,number], radius};
    for(let i=0; i<hz; i++) state = advanceOrbit(state,target,1/hz);
    assert.ok(Math.abs(state.angle * radius - FLIGHT_SPEED) < 1e-9);
    const [x,y,z] = orbitPosition(state);
    assert.ok(Math.abs(Math.hypot(x-14,z+10)-radius) < 1e-9);
    assert.equal(y, FLIGHT_HEIGHT); assert.ok(y > 15);
  }
});

test('RSSI and AP changes ease the radius and centre without restarting the flight phase', () => {
  const previous = {x: 14,z: -10,radius: 6,angle: 1};
  const next = advanceOrbit(previous,{center:[0,7.9,-1],radius:25},1/60);
  assert.ok(next.radius > 6 && next.radius < 7);
  assert.ok(next.x < 14 && next.x > 13);
  assert.ok(next.angle > 1);
});
test('invalid, missing and offline signal cannot become distance evidence', () => {
  for (const rssi of [0, NaN, Infinity, -200]) assert.equal(flightSignal(video('direct', rssi)).rssi, null);
  assert.equal(flightSignal().online, false);
  assert.equal(flightSignal({...video('relay', -45), online: false}).rssi, null);
});
test('relay and receiver remain above their respective roofs when floors are separated', () => {
  assert.ok(flightAnchors().receiver[0] > flightAnchors().relay[0]);
  assert.ok(flightAnchors(true).relay[1] > flightAnchors().relay[1]);
  assert.ok(flightAnchors(true).receiver[1] > flightAnchors().receiver[1]);
});
