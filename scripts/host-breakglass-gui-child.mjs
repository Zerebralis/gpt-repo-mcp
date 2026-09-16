/* global process, console */
import { pathToFileURL } from 'node:url';

// This is the backend process, not a launcher with another backend child.
// The private IPC channel attests that THIS generation bound the configured port.
const [entry, generation] = process.argv.slice(2);
let runtime;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await runtime?.close(); } finally { process.exit(0); }
}
process.on('message', (message) => {
  if (message?.type === 'stop' && message.generation === generation) void stop();
});
process.once('disconnect', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  const backend = await import(pathToFileURL(entry).href);
  if (stopping) process.exit(0);
  runtime = backend.startComputerUseHttpServer();
  runtime.http.once('error', () => process.exit(1));
  runtime.http.once('listening', () => {
    if (!stopping) process.send?.({ type: 'listening', generation, pid: process.pid, address: runtime.http.address() });
  });
} catch {
  console.error('Computer-Use backend startup failed.');
  process.exit(1);
}
