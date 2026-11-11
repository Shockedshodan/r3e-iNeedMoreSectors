import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

/** Raw API-shaped fixture; no normalized TimingFrame or result-ID injection. */
export interface RawRaceRoomFrame {
  VersionMajor: number;
  VersionMinor: number;
  LayoutId: number;
  LayoutLength: number;
  TrackName: string;
  LayoutName: string;
  VehicleInfo: { ModelId: number };
  SessionType: number;
  SessionIteration: number;
  EventIndex: number;
  Player: { GameSimulationTime: number };
  CompletedLaps: number;
  LapDistanceFraction: number;
  LapTimeCurrentSelf: number;
  LapValidState: number;
  LapTimePreviousSelf: number;
  SectorTimesPreviousSelf: { Sector1: number; Sector2: number; Sector3: number };
  PrevLapValid: number;
  ControlType: number;
  GameInReplay: number;
  GamePaused: number;
  GameInMenus: number;
}

export function rawFrame(overrides: Partial<RawRaceRoomFrame> = {}): RawRaceRoomFrame {
  return {
    VersionMajor: 3,
    VersionMinor: 6,
    LayoutId: 10,
    LayoutLength: 3000,
    TrackName: 'Test circuit',
    LayoutName: 'Grand prix',
    VehicleInfo: { ModelId: 20 },
    SessionType: 0,
    SessionIteration: 1,
    EventIndex: 0,
    Player: { GameSimulationTime: 10 },
    CompletedLaps: 0,
    LapDistanceFraction: 0,
    LapTimeCurrentSelf: 0,
    LapValidState: 0,
    LapTimePreviousSelf: -1,
    SectorTimesPreviousSelf: { Sector1: -1, Sector2: -1, Sector3: -1 },
    PrevLapValid: -1,
    ControlType: 0,
    GameInReplay: 0,
    GamePaused: 0,
    GameInMenus: 0,
    ...overrides,
  };
}

export function previousResult(totalSeconds: number): Pick<RawRaceRoomFrame,
  'LapTimePreviousSelf' | 'SectorTimesPreviousSelf' | 'PrevLapValid'> {
  return {
    LapTimePreviousSelf: totalSeconds,
    SectorTimesPreviousSelf: {
      Sector1: totalSeconds * 0.3,
      Sector2: totalSeconds * 0.6,
      Sector3: totalSeconds,
    },
    PrevLapValid: 1,
  };
}

/** The end frame contains a coherent wrap and a fresh cumulative official result. */
export function lapFrames(completedLaps: number, totalSeconds = 1,
  previousSeconds?: number): RawRaceRoomFrame[] {
  const previous = previousSeconds === undefined ? {} : previousResult(previousSeconds);
  const samples = [0, 0.25, 0.5, 0.75].map(fraction => rawFrame({
    ...previous,
    CompletedLaps: completedLaps,
    LapDistanceFraction: fraction,
    LapTimeCurrentSelf: fraction * totalSeconds,
    Player: { GameSimulationTime: 10 + completedLaps * 2 + fraction * totalSeconds },
  }));
  samples.push(rawFrame({
    ...previousResult(totalSeconds),
    CompletedLaps: completedLaps + 1,
    Player: { GameSimulationTime: 10 + (completedLaps + 1) * 2 },
  }));
  return samples;
}

export async function createBrowserBridge(initial: RawRaceRoomFrame | null = null) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/r3e' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge address');
  let latest = initial;
  let connections = 0;
  let polls = 0;
  server.on('connection', socket => {
    connections += 1;
    socket.on('message', data => {
      if (data.toString() !== '') throw new Error('Expected the SealHUD empty-string poll');
      polls += 1;
      if (latest && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(latest));
    });
  });

  async function send(frame: RawRaceRoomFrame): Promise<void> {
    latest = frame;
    const payload = JSON.stringify(frame);
    await Promise.all([...server.clients].filter(socket => socket.readyState === WebSocket.OPEN)
      .map(socket => new Promise<void>((resolve, reject) => {
        socket.send(payload, error => error ? reject(error) : resolve());
      })));
  }

  return {
    authority: `127.0.0.1:${address.port}`,
    connections: () => connections,
    polls: () => polls,
    activeConnections: () => server.clients.size,
    send,
    pause() { latest = null; },
    async sendFrames(frames: readonly RawRaceRoomFrame[], intervalMs = 80): Promise<void> {
      for (const frame of frames) {
        await send(frame);
        await delay(intervalMs);
      }
    },
    disconnectAll() {
      for (const socket of server.clients) socket.close(1012, 'Synthetic bridge restart');
    },
    async close(): Promise<void> {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export type BrowserBridge = Awaited<ReturnType<typeof createBrowserBridge>>;
