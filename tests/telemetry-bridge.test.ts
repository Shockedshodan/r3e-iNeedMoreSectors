import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRaceRoomBridge } from '../src/telemetry/websocket-bridge.ts';
import type { RaceRoomSocket } from '../src/telemetry/websocket-bridge.ts';
import type { AdaptedTelemetry, RaceRoomAdapter } from '../src/telemetry/raceroom-adapter.ts';
import { frame } from './helpers.ts';
import type { BridgeIngressEvent } from '../src/telemetry/websocket-bridge.ts';

class Socket implements RaceRoomSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closes = 0;
  send(data: string) { this.sent.push(data); }
  close() { this.closes += 1; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

function setup() {
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0;
  let resets = 0;
  const observation: AdaptedTelemetry = { frame: frame(), layoutLengthM: 3000, trackName: 'Track', layoutName: 'Layout' };
  const received: unknown[] = [];
  const statuses: string[] = [];
  const adapter: RaceRoomAdapter = {
    adapt(data) { received.push(data); return observation; },
    reset() { resets += 1; },
    status: () => 'Live record writes disabled',
  };
  const bridge = createRaceRoomBridge({
    adapter,
    socketFactory(url) { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket; },
    schedule(callback, delay) { tasks.set(++sequence, { callback, delay }); return sequence; },
    cancel(handle) { tasks.delete(handle as number); },
    onStatus: status => statuses.push(status),
  });
  return {
    bridge, sockets, urls, tasks, statuses, received, observation,
    resets: () => resets,
    tick() { const first = tasks.entries().next().value; assert.ok(first); tasks.delete(first[0]); first[1].callback(); },
  };
}

test('one shared socket serves listeners and sends SealHUD empty-string polls only while open', () => {
  const value = setup();
  let first = 0;
  let second = 0;
  const disconnectFirst = value.bridge.connect(() => { first += 1; });
  const disconnectSecond = value.bridge.connect(() => { second += 1; });
  assert.deepEqual(value.urls, ['ws://localhost:8070/r3e']);
  assert.equal(value.sockets.length, 1);
  assert.equal(value.sockets[0].sent.length, 0);
  value.sockets[0].open();
  assert.deepEqual(value.sockets[0].sent, ['']);
  value.tick();
  assert.deepEqual(value.sockets[0].sent, ['', '']);
  value.sockets[0].message('{"sample":1}');
  assert.deepEqual(value.received, [{ sample: 1 }]);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(value.bridge.latest(), value.observation);
  disconnectFirst();
  assert.equal(value.sockets[0].closes, 0);
  disconnectSecond();
  assert.equal(value.sockets[0].closes, 1);
  assert.equal(value.tasks.size, 0);
  assert.equal(value.bridge.latest(), null);
});

test('metadata is available before the normalized frame is distributed', () => {
  const order: string[] = [];
  const socket = new Socket();
  const observation: AdaptedTelemetry = { frame: frame(), layoutLengthM: 3000, trackName: '', layoutName: '' };
  const bridge = createRaceRoomBridge({
    socketFactory: () => socket,
    adapter: { adapt: () => observation, reset() {}, status: () => 'fixture' },
    onObservation(value) { assert.equal(value.layoutLengthM, 3000); order.push('metadata'); },
    schedule: () => 1, cancel() {},
  });
  const disconnect = bridge.connect(() => { assert.equal(bridge.latest(), observation); order.push('frame'); });
  socket.open();
  socket.message('{}');
  assert.deepEqual(order, ['metadata', 'frame']);
  disconnect();
});

test('malformed messages interrupt association and do not reach frame subscribers', () => {
  const value = setup();
  let frames = 0;
  const disconnect = value.bridge.connect(() => { frames += 1; });
  value.sockets[0].open();
  const resets = value.resets();
  value.sockets[0].message('{broken');
  assert.equal(frames, 0);
  assert.equal(value.resets(), resets + 1);
  assert.match(value.bridge.status(), /malformed/i);
  value.sockets[0].message('{}');
  assert.equal(frames, 1);
  disconnect();
});

test('disconnect clears polling, resets association, and reconnects once while listeners remain', () => {
  const value = setup();
  const disconnect = value.bridge.connect(() => {});
  value.sockets[0].open();
  value.sockets[0].drop();
  assert.equal(value.tasks.size, 1);
  assert.match(value.bridge.status(), /reconnect/i);
  value.tick();
  assert.equal(value.sockets.length, 2);
  value.sockets[1].open();
  assert.deepEqual(value.sockets[1].sent, ['']);
  disconnect();
  assert.equal(value.tasks.size, 0);
  assert.equal(value.sockets[1].closes, 1);
});

test('disposing during reconnect cancels pending creation and late old-socket events', () => {
  const value = setup();
  let frames = 0;
  const disconnect = value.bridge.connect(() => { frames += 1; });
  const old = value.sockets[0];
  const lateMessage = old.onmessage!;
  old.open();
  old.drop();
  disconnect();
  disconnect();
  assert.equal(value.tasks.size, 0);
  lateMessage({ data: '{}' });
  assert.equal(frames, 0);
  assert.equal(value.sockets.length, 1);
});

test('URL and timer configuration reject unsupported protocols and invalid intervals', () => {
  for (const url of ['https://example.test/r3e', 'file:///r3e', 'ws://user:secret@example.test/r3e']) {
    assert.throws(() => createRaceRoomBridge({ url }), RangeError);
  }
  assert.throws(() => createRaceRoomBridge({ pollMs: 0 }), RangeError);
  assert.throws(() => createRaceRoomBridge({ reconnectMs: Number.NaN }), RangeError);
});

test('ingress records raw projected values and receive time before rejected adaptation', () => {
  const socket = new Socket();
  const ingress: BridgeIngressEvent[] = [];
  const order: string[] = [];
  let now = 10;
  const bridge = createRaceRoomBridge({
    clock: () => now,
    socketFactory: () => socket,
    schedule: () => 1, cancel() {},
    onIngress(event) { ingress.push(event); order.push(event.type); },
    adapter: { adapt(value) { order.push('adapt'); now = 999; return null; }, reset() {}, status: () => 'unsupported' },
  });
  const disconnect = bridge.connect(() => { throw new Error('Rejected data cannot reach subscribers'); });
  socket.open();
  now = 20;
  socket.message(JSON.stringify({ VersionMajor: 99, CompletedLaps: 0, LapTimePreviousSelf: -1, VehicleInfo: { ModelId: 20, Name: 'private' }, DriverData: ['private'] }));
  assert.deepEqual(order, ['open', 'message', 'adapt']);
  assert.equal(ingress[1].atMs, 20);
  assert.deepEqual(ingress[1].data, { VersionMajor: 99, CompletedLaps: 0, LapTimePreviousSelf: -1, VehicleInfo: { ModelId: 20 } });
  disconnect();
});

test('malformed ingress is retained without raw text and reconnect changes connection identity', () => {
  const sockets: Socket[] = [];
  const ingress: BridgeIngressEvent[] = [];
  let task: (() => void) | undefined;
  const bridge = createRaceRoomBridge({
    clock: () => 10,
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    schedule(callback) { task = callback; return 1; }, cancel() {},
    onIngress: event => ingress.push(event),
    adapter: { adapt: () => null, reset() {}, status: () => 'fixture' },
  });
  const disconnect = bridge.connect(() => {});
  sockets[0].open();
  sockets[0].message('{private driver name');
  const malformed = ingress.find(event => event.type === 'malformed')!;
  assert.ok(malformed);
  assert.equal(malformed.messageType, 'string');
  assert.ok(malformed.byteLength! > 0);
  assert.equal(JSON.stringify(malformed).includes('private driver'), false);
  sockets[0].message(new Uint8Array([1, 2, 3]));
  const binary = ingress.find(event => event.type === 'malformed' && event.messageType === 'object');
  assert.equal(binary?.byteLength, 3);
  sockets[0].drop();
  task!();
  sockets[1].open();
  const opened = ingress.filter(event => event.type === 'open');
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0].connectionId, opened[1].connectionId);
  assert.ok(ingress.some(event => event.type === 'close'));
  disconnect();
});

test('an ingress observer cannot mutate adapter input or disrupt delivery by throwing', () => {
  const socket = new Socket();
  let received = 0;
  let attemptedMutation = 0;
  const observation: AdaptedTelemetry = { frame: frame(), layoutLengthM: 3000, trackName: '', layoutName: '' };
  const bridge = createRaceRoomBridge({
    socketFactory: () => socket, schedule: () => 1, cancel() {},
    onIngress(event) {
      if (event.type === 'message') {
        attemptedMutation += 1;
        (event.data as { VehicleInfo: { ModelId: number } }).VehicleInfo.ModelId = 999;
      }
      throw new Error('Diagnostic sink failure');
    },
    adapter: { adapt(value) { assert.equal((value as { VehicleInfo: { ModelId: number } }).VehicleInfo.ModelId, 20); return observation; }, reset() {}, status: () => 'fixture' },
  });
  const disconnect = bridge.connect(() => { received += 1; });
  socket.open();
  socket.message('{"VehicleInfo":{"ModelId":20}}');
  assert.equal(received, 1);
  assert.equal(attemptedMutation, 1);
  assert.equal(socket.sent.length, 1);
  disconnect();
});

test('valid JSON with an unrepresentable numeric field leaves an explicit diagnostic rejection', () => {
  const socket = new Socket();
  const captured: BridgeIngressEvent[] = [];
  let adapterValue: unknown;
  const bridge = createRaceRoomBridge({
    socketFactory: () => socket, schedule: () => 1, cancel() {}, clock: () => 123,
    onIngress: event => captured.push(event),
    adapter: { adapt(value) { adapterValue = value; return null; }, reset() {}, status: () => 'unavailable timing' },
  });
  const disconnect = bridge.connect(() => { throw new Error('Rejected data must not be delivered'); });
  socket.open();
  socket.message('{"LapTimeCurrentSelf":1e400,"DriverData":["private"]}');
  const rejection = captured.find(event => event.type === 'malformed');
  assert.ok(rejection, 'projection failure must not silently remove a received message');
  assert.equal(rejection.atMs, 123);
  assert.equal(rejection.connectionId, captured[0].connectionId);
  assert.equal(rejection.reason, 'projection-unrepresentable');
  assert.equal(rejection.messageType, 'string');
  assert.ok(rejection.byteLength! > 0);
  assert.equal(rejection.data, undefined);
  assert.equal(JSON.stringify(rejection).includes('private'), false);
  assert.equal((adapterValue as { LapTimeCurrentSelf: number }).LapTimeCurrentSelf, Infinity);
  disconnect();
});
