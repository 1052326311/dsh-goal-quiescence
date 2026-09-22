# dsh-goal-quiescence

**Do not complete a Harness goal while observed subagent evidence is still
running or has not been explicitly returned to the goal agent.**

`dsh-goal-quiescence` is a community plugin for DeepSeek Harness. It addresses
the goal-mode failure reported in [DeepSeek Harness Discussion #284](https://github.com/deepseek-ai/deepseek-harness/discussions/284): a parent can call
`update_goal(action=complete)` while background reviewers are still running,
after which their result can arrive too late to affect the completed goal.

## What it enforces

For every subagent run observed after the plugin has loaded under an active
goal, the plugin records the public `subagent/start` and `subagent/end`
lifecycle pair. It then denies `update_goal(action=complete)` until:

1. Every observed child run has settled.
2. The goal agent calls `goal_quiescence_ack` for every settled run. That tool
   returns the run's terminal assistant output as its own tool result, making
   the evidence visible in the parent agent's current context.

Acknowledgement commits only after the real ToolRuntime pipeline returns a
successful top-level result that still contains the plugin's complete evidence
block. A post-execute policy that blocks or replaces that content leaves the
run pending, and nested transport calls are rejected because their output is
not direct evidence in the parent agent's context.

`goal_quiescence_status` gives a bounded list of the runs that still block
completion. The plugin does not schedule, cancel, or retry children, and it
does not replace Harness goal mode.

## Install

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-goal-quiescence-<version>.tgz
```

The bundled patch enables the plugin. It requires the normal Harness `goal`,
`subagent`, and `tools` services provided by the Web profile.

## Completion flow

1. Work normally in goal mode and delegate background reviews as needed.
2. If goal completion is denied, call `goal_quiescence_status`.
3. Wait for each `running` run to settle.
4. Call `goal_quiescence_ack` with each returned `runId`; inspect the terminal
   output it returns.
5. Resolve any reported finding, then call `update_goal(action=complete)`.

## Guarantees and boundaries

The gate is a process-local lifecycle policy. It covers runs that begin after
the plugin is loaded and completion attempts made through the model-facing
`update_goal` tool. The policy deliberately does not claim to be an atomic core
transaction: direct service calls, a process restart, or a child that began
before plugin activation are outside its observable boundary. A core lifecycle
permit would be needed for an end-to-end atomic guarantee.

Within that boundary, acknowledgement is not a metadata checkbox: the
acknowledgement tool returns the saved terminal output into the parent agent's
tool context before it releases completion. This prevents the specific
"settled but unseen" state from being treated as complete.

## Verification

The integration test mounts the real Harness `ToolRuntime`, `GoalService`, and
`SubagentRuntime`. It starts a real runtime lifecycle through a deferred
provider, proves completion is denied while the child is running, proves it is
still denied after settlement and after blocked, replaced, or nested
acknowledgements, verifies the child output reaches the final acknowledgement
tool result, covers failed children with no terminal output, and finally
completes the unchanged goal revision.

```sh
pnpm test
pnpm check
pnpm run smoke:package
```

The package smoke test installs the packed artifact into an isolated temporary
DSH home, boots the real Web profile on DSH `0.1.6-alpha.2`, and verifies that
both goal-quiescence tools are registered. Its JSON result records the package
SHA-256, DSH version, Node version, profile, tool names, and HTTP status.
