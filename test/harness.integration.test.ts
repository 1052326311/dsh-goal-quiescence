import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { type SubagentResult, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
}

function stubAgent(id: string): StubAgent {
  const session = Session.create(SessionId(id))
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

function openHumanTurn(root: StubAgent): void {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'Finish this work carefully.' }],
    source: { kind: 'user' },
  })
  root.agent.inbox.append('next-turn', message)
  const claimed = root.agent.inbox.claim('next-turn', 1)
  root.session.append('turn/start', { turn: 1 })
  for (const admitted of claimed) root.session.append('user/message', admitted, { surfaceOp: 'append' })
}

function resultValue(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError || !result.value || typeof result.value !== 'object') throw new Error('expected successful JSON result')
  return result.value as Record<string, unknown>
}

async function execute(ctx: Context, root: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.agents.withInitiator(root, () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent: root,
  }))
}

describe('goal quiescence lifecycle guard', () => {
  it('blocks completion until a real subagent lifecycle settles and its terminal result is returned to the goal agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(GoalService)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(ToolGoal)
    apply(ctx)

    const root = stubAgent('root-goal')
    ctx.agents.register(root.agent)
    const goal = ctx.goals.create(root.agent, { objective: 'Ship verified output' })
    openHumanTurn(root)

    const ready = Promise.withResolvers<SubagentRun>()
    const settled = Promise.withResolvers<SubagentResult>()
    ctx.subagents.registerProvider({
      name: 'deferred',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => ready.promise,
    })

    const scopeParents: unknown[] = []
    ctx.on('subagent/start', function () { scopeParents.push(carrierKeyOf(this)) })
    const starting = ctx.subagents.start('deferred', {
      parent: root.agent,
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
    expect(scopeParents).toEqual([root.agent])

    const whileRunning = await execute(ctx, root.agent, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(whileRunning.isError).toBe(true)
    expect(JSON.stringify(whileRunning.content)).toContain('GOAL_QUIESCENCE_PENDING')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')

    settled.resolve({
      output: [{ type: 'text', text: 'CHILD_REVIEW_SENTINEL: found no remaining defect.' }],
      stopReason: 'completed',
    })
    await run.result
    await Promise.resolve()

    const afterSettlement = await execute(ctx, root.agent, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(afterSettlement.isError).toBe(true)
    expect(JSON.stringify(afterSettlement.content)).toContain('settled result')

    const status = resultValue(await execute(ctx, root.agent, 'goal_quiescence_status', {}))
    const pending = status.pending as Array<{ runId: string; phase: string }>
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ phase: 'settled' })

    const acknowledgementResult = await execute(ctx, root.agent, 'goal_quiescence_ack', { run_id: pending[0].runId })
    const acknowledged = resultValue(acknowledgementResult)
    expect(JSON.stringify(acknowledged)).toContain('CHILD_REVIEW_SENTINEL')
    expect(JSON.stringify(acknowledgementResult.content)).toContain('CHILD_REVIEW_SENTINEL')

    const complete = await execute(ctx, root.agent, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(complete.isError).toBe(false)
    expect(ctx.goals.get(root.agent)?.phase).toBe('complete')
  })
})
