# Repository work

For agent tool composition, read [the canonical orchestration contract](docs/AGENT_ORCHESTRATION.md).
Client-side guards live in `src/agent-orchestration.ts`; the shared MCP instructions live in
`src/orchestration/instructions.ts`. Do not implement caller dependency/intent state in
the Breakglass server or weaken its existing policies.

Validate changes with focused Vitest tests, `npm run typecheck`, `npm run lint` and
`npm run build` as appropriate. Local CI discovery is documented in Markus's
`00_System/LOCAL_CI_RUNNER.md`; its installed runner may push/update external state
and is not equivalent to a local syntax check. Git publication and runtime deployment
require their own authorization.
