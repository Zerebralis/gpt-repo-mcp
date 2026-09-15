import { describe, expect, test } from 'vitest';
import {
  assertLoopbackHealthBase,
  classifyPollFreshness,
  parseLastSuccessfulPoll,
  probeTunnelPollHealth
} from '../scripts/tunnel-poll-health.mjs';

describe('tunnel control-plane poll health', () => {
  test('parses the tunnel-client last-success gauge', () => {
    expect(parseLastSuccessfulPoll(`
# HELP commands_poll_last_successful_timestamp_seconds Unix timestamp
commands_poll_last_successful_timestamp_seconds 1720000000
`)).toBe(1720000000);
  });

  test('parses the scientific notation emitted by tunnel-client v0.0.14', () => {
    expect(parseLastSuccessfulPoll('commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} 1.789486034e+09')).toBe(1789486034);
  });

  test('accepts prefixes and labels and uses the newest sample', () => {
    expect(parseLastSuccessfulPoll(`
other_metric 99
otel_scope_commands_poll_last_successful_timestamp_seconds{channel="main"} 1720000001
commands_poll_last_successful_timestamp_seconds{channel="harpoon"} 1720000003
`)).toBe(1720000003);
  });

  test('classifies never-successful, fresh, and stale poll state', () => {
    expect(classifyPollFreshness(0, { nowMs: 200000, staleMs: 60000 })).toMatchObject({ fresh: false, status: 'never_succeeded', ageMs: null });
    expect(classifyPollFreshness(150, { nowMs: 200000, staleMs: 60000 })).toMatchObject({ fresh: true, status: 'fresh', ageMs: 50000 });
    expect(classifyPollFreshness(100, { nowMs: 200001, staleMs: 60000 })).toMatchObject({ fresh: false, status: 'stale', ageMs: 100001 });
  });

  test('refuses non-loopback or path-bearing health bases', () => {
    expect(() => assertLoopbackHealthBase('https://example.com:8080')).toThrow(/loopback/i);
    expect(() => assertLoopbackHealthBase('http://127.0.0.1:8080/admin')).toThrow(/path/i);
    expect(assertLoopbackHealthBase('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  test('probes metrics and reports a fresh poll', async () => {
    const result = await probeTunnelPollHealth('http://127.0.0.1:8080', {
      nowMs: 1720000060000,
      staleMs: 120000,
      fetchImpl: async () => ({ ok: true, text: async () => 'commands_poll_last_successful_timestamp_seconds 1720000000\n' })
    });
    expect(result).toMatchObject({ fresh: true, status: 'fresh', lastSuccessUnixSeconds: 1720000000, ageMs: 60000 });
  });
});
