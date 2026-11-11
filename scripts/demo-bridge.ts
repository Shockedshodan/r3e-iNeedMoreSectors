/**
 * Development-only RaceRoom-shaped telemetry, accelerated to one lap per 3.2 s.
 * Run the HUD with ?demo=1 to keep these fictional records in demo storage.
 * This is not a native shared-memory reader or evidence of live field ordering.
 */
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.DEMO_BRIDGE_PORT ?? 8070);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new RangeError('DEMO_BRIDGE_PORT must be an integer between 0 and 65535');
}

const stepsPerLap = 64;
const tickMs = 50;
const lapTimes = [91.8, 91.2, 91.5, 90.9, 91.3, 90.6, 91.0, 90.4];
let completedLaps = 0;
let step = 0;
let elapsedSimulationSeconds = 0;
let previous: {
  LapTimePreviousSelf: number;
  SectorTimesPreviousSelf: { Sector1: number; Sector2: number; Sector3: number };
  PrevLapValid: number;
} = {
  LapTimePreviousSelf: -1,
  SectorTimesPreviousSelf: { Sector1: -1, Sector2: -1, Sector3: -1 },
  PrevLapValid: -1,
};

function lapTotal(lap: number): number {
  return lapTimes[lap % lapTimes.length];
}

/** A monotonic nonlinear curve gives the saved delta visible changes in pace. */
function lapElapsed(lap: number, fraction: number): number {
  const progress = fraction + 0.025 * Math.sin(2 * Math.PI * fraction)
    + 0.008 * Math.sin(6 * Math.PI * fraction + lap * 0.8) * Math.sin(Math.PI * fraction);
  return Math.round(lapTotal(lap) * progress * 1_000_000) / 1_000_000;
}

function rawFrame() {
  const fraction = step / stepsPerLap;
  const elapsed = lapElapsed(completedLaps, fraction);
  return {
    VersionMajor: 3,
    VersionMinor: 6,
    LayoutId: 900_001,
    LayoutLength: 9000,
    TrackName: 'Demo circuit',
    LayoutName: 'Nine kilometre test layout',
    VehicleInfo: { ModelId: 42 },
    SessionType: 0,
    SessionIteration: 1,
    EventIndex: 0,
    Player: { GameSimulationTime: 10 + elapsedSimulationSeconds + elapsed },
    CompletedLaps: completedLaps,
    LapDistanceFraction: fraction,
    LapTimeCurrentSelf: elapsed,
    LapValidState: 0,
    ...previous,
    ControlType: 0,
    GameInReplay: 0,
    GamePaused: 0,
    GameInMenus: 0,
  };
}

let latest = JSON.stringify(rawFrame());
let timer: ReturnType<typeof setInterval> | null = null;
let stopping = false;
const server = new WebSocketServer({ host: '127.0.0.1', port, path: '/r3e' });

function send(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(latest);
}

server.on('connection', socket => {
  send(socket);
  socket.on('message', data => {
    // SealHUD-compatible bridges answer an empty-string telemetry poll.
    if (data.toString() === '') send(socket);
    else socket.close(1003, 'Expected an empty telemetry poll');
  });
  socket.on('error', () => { socket.terminate(); });
});

server.once('listening', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing demo bridge address');
  console.log(`Demo telemetry bridge listening at ws://127.0.0.1:${address.port}/r3e`);
  console.log('Use the HUD query ?demo=1; fictional 90–92 second laps run every 3.2 seconds.');
  timer = setInterval(() => {
    step += 1;
    if (step === stepsPerLap) {
      const total = lapTotal(completedLaps);
      previous = {
        LapTimePreviousSelf: total,
        // Native sector fields are cumulative; the HUD derives independent
        // native durations and its six custom sectors separately.
        SectorTimesPreviousSelf: {
          Sector1: lapElapsed(completedLaps, 1 / 3),
          Sector2: lapElapsed(completedLaps, 2 / 3),
          Sector3: total,
        },
        PrevLapValid: 1,
      };
      elapsedSimulationSeconds += total;
      completedLaps += 1;
      step = 0;
    }
    latest = JSON.stringify(rawFrame());
    for (const socket of server.clients) send(socket);
  }, tickMs);
});

function stop(): void {
  if (stopping) return;
  stopping = true;
  if (timer !== null) clearInterval(timer);
  for (const socket of server.clients) socket.terminate();
  server.close(error => { if (error) process.exitCode = 1; });
}

server.on('error', error => {
  console.error(`Demo bridge failed: ${error.message}`);
  process.exitCode = 1;
  stop();
});
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
