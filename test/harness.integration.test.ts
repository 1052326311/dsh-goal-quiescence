import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { type SubagentResult, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import { type ToolExecutionResult, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'

class HoldingAdapter extends LlmAdapter {
  readonly started = Promise.withResolvers<void>()
  private readonly released = Promise.withResolvers<void>()

  close(): void {
    this.released.resolve()
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.started.resolve()
    await this.released.promise
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function openHumanTurn(root: Agent, adapter: HoldingAdapter): Promise<void> {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'Finish this work carefully.' }],
    source: { kind: 'user' },
  })
  root.followup(message)
  await adapter.started.promise
}

function resultText(result: ToolExecutionResult): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function contentText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected successful tool result')
  return resultText(result)
}

function statusRunId(content: string): string {
  const marker = 'Pending subagent runs:\n'
  const markerIndex = content.indexOf(marker)
  if (markerIndex < 0) throw new Error('expected rendered pending subagent runs')
  const rendered = JSON.parse(content.slice(markerIndex + marker.length)) as {
    pending?: Array<{ runId?: unknown }>
  }
  const runId = rendered.pending?.[0]?.runId
  if (typeof runId !== 'string') throw new Error('expected rendered runId')
  return runId
}

async function execute(
  ctx: Context,
  root: Agent,
  name: string,
  args: unknown,
  parent?: ToolExecutionToken,
): Promise<ToolExecutionResult> {
  return ctx.agents.withInitiator(root, () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent: root,
    ...(parent === undefined ? {} : { parent }),
  }))
}

const contexts: Context[] = []
const adapters: HoldingAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.close()
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

async function createHarness(id: string): Promise<{
  ctx: Context
  root: Agent
  adapter: HoldingAdapter
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(SubagentRuntime)
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ToolGoal)
  apply(ctx)
  const adapter = new HoldingAdapter()
  adapters.push(adapter)
  ctx.llm.registerAdapter(['holding'], adapter)
  const root = await harness.create(SessionId(id), { provider: 'holding', model: 'holding' })
  return { ctx, root, adapter }
}

describe('goal quiescence lifecycle guard', () => {
  it('blocks completion until a real subagent lifecycle settles and its terminal result is returned to the goal agent', async () => {
    const { ctx, root, adapter } = await createHarness('root-goal')

    let acknowledgementPolicy: 'accept' | 'block' | 'replace' = 'accept'
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name !== 'goal_quiescence_ack' || acknowledgementPolicy === 'accept') return next()
      if (acknowledgementPolicy === 'block') {
        return { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'Blocked by output policy' }] }
      }
      return { kind: 'accept' as const, content: [{ type: 'text' as const, text: 'Acknowledgement evidence replaced' }] }
    })

    const goal = ctx.goals.create(root, { objective: 'Ship verified output' })
    await openHumanTurn(root, adapter)

    const ready = Promise.withResolvers<SubagentRun>()
    const settled = Promise.withResolvers<SubagentResult>()
    ctx.subagents.registerProvider({
      name: 'deferred',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => ready.promise,
    })

    const scopeParents: unknown[] = []
    ctx.on('subagent/start', function () { scopeParents.push(carrierKeyOf(this)) })
    const starting = ctx.subagents.start('deferred', {
      parent: root,
      prompt: [{ type: 'text', text: 'Review the final artifact.' }],
      signal: new AbortController().signal,
    })
    ready.resolve({
      id: SessionId('child-reviewer'),
      localAgent: undefined,
      result: settled.promise,
      dispose: async () => {},
    })
    const run = await starting
    expect(scopeParents).toEqual([root])

    const whileRunning = await execute(ctx, root, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(whileRunning.isError).toBe(true)
    expect(JSON.stringify(whileRunning.content)).toContain('GOAL_QUIESCENCE_PENDING')
    expect(ctx.goals.get(root)?.phase).toBe('active')

    settled.resolve({
      output: [{ type: 'text', text: 'CHILD_REVIEW_SENTINEL: found no remaining defect.' }],
      stopReason: 'completed',
    })
    await run.result
    await Promise.resolve()

    const afterSettlement = await execute(ctx, root, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(afterSettlement.isError).toBe(true)
    expect(JSON.stringify(afterSettlement.content)).toContain('settled result')

    const statusResult = await execute(ctx, root, 'goal_quiescence_status', {})
    const statusContent = contentText(statusResult)
    expect(statusContent).toContain('"phase":"settled"')
    const runId = statusRunId(statusContent)

    const nestedAcknowledgement = await execute(
      ctx,
      root,
      'goal_quiescence_ack',
      { run_id: runId },
      Symbol('nested-transport') as ToolExecutionToken,
    )
    expect(nestedAcknowledgement.isError).toBe(true)
    expect(resultText(nestedAcknowledgement)).toContain('must be called directly')
    expect(statusRunId(contentText(await execute(ctx, root, 'goal_quiescence_status', {})))).toBe(runId)

    acknowledgementPolicy = 'block'
    const blockedAcknowledgement = await execute(ctx, root, 'goal_quiescence_ack', { run_id: runId })
    expect(blockedAcknowledgement.isError).toBe(true)
    expect(resultText(blockedAcknowledgement)).toContain('Blocked by output policy')
    expect(statusRunId(contentText(await execute(ctx, root, 'goal_quiescence_status', {})))).toBe(runId)

    const afterBlockedAcknowledgement = await execute(ctx, root, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(afterBlockedAcknowledgement.isError).toBe(true)

    acknowledgementPolicy = 'replace'
    const replacedAcknowledgement = await execute(ctx, root, 'goal_quiescence_ack', { run_id: runId })
    expect(replacedAcknowledgement.isError).toBe(false)
    expect(contentText(replacedAcknowledgement)).toBe('Acknowledgement evidence replaced')
    expect(statusRunId(contentText(await execute(ctx, root, 'goal_quiescence_status', {})))).toBe(runId)

    const afterReplacedAcknowledgement = await execute(ctx, root, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(afterReplacedAcknowledgement.isError).toBe(true)

    acknowledgementPolicy = 'accept'
    const acknowledgementResult = await execute(ctx, root, 'goal_quiescence_ack', { run_id: runId })
    const acknowledgementContent = contentText(acknowledgementResult)
    expect(acknowledgementContent).toContain('Stop reason: completed')
    expect(acknowledgementContent).toContain('CHILD_REVIEW_SENTINEL')

    const complete = await execute(ctx, root, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(complete.isError, JSON.stringify(complete)).toBe(false)
    expect(ctx.goals.get(root)?.phase).toBe('complete')
  })

  it('surfaces an error stop reason when a settled child has no terminal assistant output', async () => {
    const { ctx, root, adapter } = await createHarness('root-no-output')
    ctx.goals.create(root, { objective: 'Inspect failed child evidence' })
    await openHumanTurn(root, adapter)

    ctx.subagents.registerProvider({
      name: 'failed-without-output',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('child-no-output'),
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'error' }),
        dispose: async () => {},
      }),
    })

    const run = await ctx.subagents.start('failed-without-output', {
      parent: root,
      prompt: [{ type: 'text', text: 'Inspect the failed operation.' }],
      signal: new AbortController().signal,
    })
    await run.result
    await Promise.resolve()

    const status = contentText(await execute(ctx, root, 'goal_quiescence_status', {}))
    const acknowledgement = contentText(await execute(ctx, root, 'goal_quiescence_ack', {
      run_id: statusRunId(status),
    }))
    expect(acknowledgement).toContain('Stop reason: error')
    expect(acknowledgement).toContain('No terminal assistant output was reported.')
  })
})
