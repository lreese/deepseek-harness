# Agent Note: Plugin ctx.fs writes attributed to the invoking session

Status: implemented

## Problem

Under the default session posture (`workspace-write` + approval `ask`), every mutating plugin slash-command write through `ctx.fs` was denied with `FS_SANDBOX_DENIED`. The command handler resolved paths against the session workspace correctly, but `SandboxedFileSystem.checkedTarget` resolved its policy with no session when the caller passed no per-call policy, so the write was evaluated against the agentless fallback root (the server's launch directory) — a different principal than the chat agent's file tools, which resolve the session's mode and cwd for every mutation. Reads were unaffected, masking the breakage until a plugin's first required write (reported as dsh-product-flow issue 003 §A). The fence itself ([cross-family fs sandbox](2026-07-14-cross-family-fs-sandbox.md)) and the initiator mechanism ([agent initiator scope](2026-07-15-agent-initiator-scope.md)) are unchanged; this decision only joins them.

## Decision

Command handlers now execute inside the receiving agent's initiator scope, and the fs fence consumes that attribution:

- `dsh-commands` wraps `command.definition.handler(invocation)` in `ctx.agents.withInitiator(agent, …)` (optional `ctx.get('agents')`; an agentless composition keeps the previous unattributed behavior). A command that reaches the executor while the registry's initiator scope is closing or disposed fails loud rather than silently dropping attribution — `withInitiator` rethrows and the execution settles as a `command/done` error.
- `dsh-fs-sandbox` resolves a per-call-less mutation's policy from `ctx.agents.currentInitiator()?.session` via `sandboxPolicy.resolve({ session })`, so the mode override and workspace root come from the invoking session; outside initiator boundaries the deployment fallback applies unchanged. A disposed registry's failing `currentInitiator()` read is contained there (agentless fallback) because the fence, not the registry, owns the mutation's failure mode.

Only the principal resolution widens — containment is unchanged. A write outside the session workspace still denies even when it falls inside the fallback root (the session boundary replaces the fallback, it does not widen to its union), and a `read-only` session or default still denies. `ctx.shell` and the tool layer are untouched: `dsh-tool-fs` already passes an explicit per-call policy, which continues to outrank the initiator resolution.

## Alternatives considered

**A sandbox carve-out for capability-token'd route-handler writes.** Wider than needed for the command path and leaves slash commands broken; browser-click attribution instead belongs to the plugin wrapping its route handler in `withInitiator` using its persisted `.capability-session` identity, which this change makes effective.

**Plugins passing an explicit per-call policy themselves.** Every plugin would restate the trust decision, and a wrong root widens scope silently; the initiator boundary is established once by the registry that knows the receiving agent.

**Propose–agent–verify degradation in the plugin.** Loses `replaceIfVersion` guarded writes — the plugin's concurrency spine — and was already recorded there as a last resort.

## Consequences

`workspace-write` now means "writes inside the session workspace" for every in-scope write regardless of which surface initiated it. Plugin code running inside a command handler gets session-attributed `ctx.fs` policy for free; plugin route handlers and other surfaces that run outside an initiator boundary still resolve the agentless fallback until they establish attribution themselves. `dsh-fs-sandbox` declares `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-session` as peer+dev dependencies with tsconfig references, type-only consumption matching `dsh-sandbox-policy`. A command handler that ignores its abort signal now also holds the agents registry's initiator disposal open until its returned promise settles — shutdown waits on uncooperative handlers, the documented `withInitiator` foreground-lifetime contract.

Coverage: `dsh-commands` tests assert the handler sees `currentInitiator() === agent` synchronously and across awaits, and that agentless compositions still run; `dsh-fs-sandbox` tests boot the fallback root distinct from the session cwd and assert the attributed write lands, the out-of-session-cwd write (inside the fallback root) denies, read-only still denies, agentless calls keep the fallback root, both `sandbox/mode` override directions hold, and an end-to-end slash-command handler write through `ctx.fs` lands under the invoking session.
