/* global process, setTimeout */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createCoreLivenessWatchdog } from '../scripts/host-breakglass-core-liveness.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runStrictAbortChild(mode) {
  let toolCallSeen = false;
  let requestClosed = false;
  const server = createServer(async (req, res) => {
    res.on('close', () => { requestClosed = true; });
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.method === 'initialize') {
      if (mode === 'timeout-initialize') return;
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'strict-test' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'strict', version: '1' } }
      }));
      return;
    }
    if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    if (message.method === 'tools/call') { toolCallSeen = true; return; }
    res.writeHead(400).end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const watchdog = createCoreLivenessWatchdog(
    { pid: 42, port: server.address().port },
    { intervalMs: 5000, timeoutMs: 100 }
  );

  try {
    watchdog.start();
    if (mode === 'timeout-initialize') {
      const deadline = Date.now() + 3000;
      while (watchdog.state().failures < 1 && Date.now() < deadline) await sleep(10);
      if (watchdog.state().failures !== 1) throw Error('timeout failure not observed');
      await sleep(250);
    } else if (mode === 'stop-tool') {
      const deadline = Date.now() + 3000;
      while (!toolCallSeen && Date.now() < deadline) await sleep(10);
      if (!toolCallSeen) throw Error('tool call not observed');
      await watchdog.stop();
      await sleep(250);
    } else {
      throw Error('unknown child mode');
    }
    process.stdout.write(JSON.stringify({ mode, state: watchdog.state(), requestClosed, toolCallSeen }) + '\n');
  } finally {
    await watchdog.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const childMode = process.argv.find(arg => arg.startsWith('--strict-abort-child='));
if (childMode) {
  await runStrictAbortChild(childMode.split('=')[1]);
} else {
  const { describe, expect, it } = await import('vitest');

  describe('Core liveness abort races under strict unhandled-rejection policy', () => {
    for (const mode of ['timeout-initialize', 'stop-tool']) {
      it(`does not emit an unhandled rejection for ${mode}`, () => {
        const child = spawnSync(process.execPath, [
          '--unhandled-rejections=strict',
          fileURLToPath(import.meta.url),
          `--strict-abort-child=${mode}`
        ], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true
        });

        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr || child.stdout).toBe(0);
        const line = child.stdout.trim().split(/\r?\n/).at(-1);
        const result = JSON.parse(line);
        expect(result.requestClosed).toBe(true);
        if (mode === 'timeout-initialize') {
          expect(result.state).toMatchObject({ status: 'degraded', failures: 1, probes: 1 });
        } else {
          expect(result.toolCallSeen).toBe(true);
          expect(result.state).toMatchObject({ status: 'stopped', failures: 0, probes: 1 });
        }
      }, 15000);
    }
  });
}
