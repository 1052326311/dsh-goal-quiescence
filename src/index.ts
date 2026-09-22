/**
 * Goal Quiescence Gate: do not let a goal complete before its observed
 * subagent runs settle and their terminal output is explicitly returned to the
 * owning goal agent.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-goal'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'goal-quiescence'
export const inject = ['agents', 'goals', 'subagents', 'tools']

interface GoalKey {
  readonly rootId: string
  readonly goalId: string
}

interface RunRecord extends GoalKey {
  readonly runId: string
  readonly childId: string
  phase: 'running' | 'settled'
  acknowledged: boolean
  stopReason?: string
  lastAssistantMessage?: ContentBlock[]
}

interface CompleteArgs {
  readonly goal_id?: unknown
  readonly action?: unknown
}

interface PendingAcknowledgement extends GoalKey {
  readonly runId: string
  readonly value: Record<string, unknown>
}

function json(value: unknown): never {
  return value as never
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function completeArgs(value: unknown): CompleteArgs | undefined {
  return isRecord(value) && value.action === 'complete' && typeof value.goal_id === 'string'
    ? value
    : undefined
}

function goalKey(ctx: Context, agent: Agent): GoalKey | undefined {
  const goal = ctx.goals.get(agent)
  if (goal === undefined || goal.phase === 'complete') return undefined
  return { rootId: String(agent.id), goalId: String(goal.id) }
}

function equalGoal(left: GoalKey, right: GoalKey): boolean {
  return left.rootId === right.rootId && left.goalId === right.goalId
}

function statusOutput(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = isRecord(value) ? value : {}
  const message = typeof record.message === 'string' ? record.message : 'Goal quiescence status unavailable.'
  const pending = Array.isArray(record.pending) ? record.pending : []
  const omitted = typeof record.omitted === 'number' ? record.omitted : 0
  return [{
    type: 'text',
    text: `${message}\n\nPending subagent runs:\n${JSON.stringify({ pending, omitted })}`,
  }]
}

function acknowledgementOutput(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const record = isRecord(value) ? value : {}
  const run = isRecord(record.run) ? record.run : {}
  const terminal = Array.isArray(run.lastAssistantMessage) ? run.lastAssistantMessage : []
  const message = typeof record.message === 'string' ? record.message : 'Goal quiescence acknowledged a subagent run.'
  const stopReason = typeof run.stopReason === 'string' ? run.stopReason : 'not reported'
  const terminalText = terminal.length > 0
    ? JSON.stringify(terminal)
    : 'No terminal assistant output was reported.'
  return [{
    type: 'text',
    text: `${message}\n\nStop reason: ${stopReason}\n\nTerminal subagent result:\n${terminalText}`,
  }]
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Install the completion guard plus bounded status and terminal-evidence tools. */
export function apply(ctx: Context): void {
  const runs = new Map<string, RunRecord>()
  const childGoals = new Map<string, GoalKey>()
  const pendingAcknowledgements = new Map<symbol, PendingAcknowledgement>()

  function liveAgent(value: unknown): Agent | undefined {
    if (!isRecord(value) || !('id' in value)) return undefined
    const candidate = value as unknown as Agent
    return ctx.agents.get(candidate.id) === candidate ? candidate : undefined
  }

  function trackedGoal(parent: Agent): GoalKey | undefined {
    return goalKey(ctx, parent) ?? childGoals.get(String(parent.id))
  }

  function recordsFor(key: GoalKey): RunRecord[] {
    return [...runs.values()].filter(record => equalGoal(record, key))
  }

  function pendingSummary(records: readonly RunRecord[]): string {
    const running = records.filter(record => record.phase === 'running')
    const unacknowledged = records.filter(record => record.phase === 'settled' && !record.acknowledged)
    const reasons: string[] = []
    if (running.length > 0) reasons.push(`${running.length} subagent run(s) still running`)
    if (unacknowledged.length > 0) reasons.push(`${unacknowledged.length} settled result(s) not acknowledged`)
    return reasons.join('; ')
  }

  ctx.on('subagent/start', function (info: SubagentRunInfo) {
    const parent = liveAgent(carrierKeyOf(this))
    if (parent === undefined) return
    const key = trackedGoal(parent)
    if (key === undefined) return
    const record: RunRecord = {
      ...key,
      runId: String(info.runId),
      childId: String(info.id),
      phase: 'running',
      acknowledged: false,
    }
    runs.set(record.runId, record)
    childGoals.set(record.childId, key)
  })

  ctx.on('subagent/end', function (info: SubagentRunEndInfo) {
    const record = runs.get(String(info.runId))
    if (record === undefined) return
    record.phase = 'settled'
    record.stopReason = info.stopReason
    if (info.lastAssistantMessage !== undefined) record.lastAssistantMessage = info.lastAssistantMessage
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = completeArgs(exec.arguments)
    if (exec.name !== 'update_goal' || args === undefined || exec.agent === undefined) return next()
    const key = goalKey(ctx, exec.agent)
    if (key === undefined || key.goalId !== args.goal_id) return next()
    const pending = recordsFor(key).filter(record => record.phase === 'running' || !record.acknowledged)
    if (pending.length === 0) return next()
    return {
      kind: 'deny' as const,
      reason: `GOAL_QUIESCENCE_PENDING: cannot complete this goal while ${pendingSummary(pending)}. Call goal_quiescence_status, wait for running work, then call goal_quiescence_ack for every settled run so its terminal output is returned to this agent.`,
    }
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'goal_quiescence_ack') return
    const candidate = pendingAcknowledgements.get(exec.token)
    pendingAcknowledgements.delete(exec.token)
    if (candidate === undefined || exec.parent !== undefined || exec.agent === undefined || result.isError) return
    const key = goalKey(ctx, exec.agent)
    const record = runs.get(candidate.runId)
    if (key === undefined || !equalGoal(candidate, key) || record === undefined || !equalGoal(record, key)) return
    if (!sameJson(result.value, candidate.value)) return
    const expectedContent = acknowledgementOutput(exec.arguments, result.value)
    if (!expectedContent.every(expected => result.content.some(actual => sameJson(actual, expected)))) return
    record.acknowledged = true
  })

  ctx.tools.register(defineTool({
    name: 'goal_quiescence_status',
    description: 'List this goal\'s observed subagent runs that still block completion. Use it before claiming a goal is complete.',
    parameters: {},
    output: { schema: { type: 'json' }, render: statusOutput },
    execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('goal quiescence requires an owning goal agent')
      const key = goalKey(ctx, exec.agent)
      if (key === undefined) throw new Error('goal quiescence requires a current non-complete goal')
      const records = recordsFor(key)
      const pending = records.filter(record => record.phase === 'running' || !record.acknowledged)
      return Promise.resolve(json({
        message: pending.length === 0
          ? 'No observed subagent run blocks goal completion.'
          : `${pending.length} observed subagent run(s) still block goal completion.`,
        pending: pending.slice(0, 32).map(record => ({
          runId: record.runId,
          childId: record.childId,
          phase: record.phase,
          ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
          acknowledged: record.acknowledged,
        })),
        omitted: Math.max(0, pending.length - 32),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'goal_quiescence_ack',
    description: 'Return one settled subagent run\'s terminal result into this goal agent\'s tool context and record that it has been explicitly considered before completion.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact runId returned by goal_quiescence_status.' },
    },
    output: { schema: { type: 'json' }, render: acknowledgementOutput },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('goal quiescence requires an owning goal agent')
      if (exec.parent !== undefined) throw new Error('goal quiescence acknowledgement must be called directly so its evidence reaches the goal agent')
      const key = goalKey(ctx, exec.agent)
      if (key === undefined) throw new Error('goal quiescence requires a current non-complete goal')
      const record = runs.get(args.run_id)
      if (record === undefined || !equalGoal(record, key)) throw new Error('subagent run is not observed for this current goal')
      if (record.phase === 'running') throw new Error('subagent run is still running; wait before acknowledging its terminal result')
      const value = {
        message: `Acknowledged settled subagent run ${record.runId}. Its terminal result is now in this goal agent's tool context.`,
        run: {
          runId: record.runId,
          childId: record.childId,
          stopReason: record.stopReason,
          lastAssistantMessage: record.lastAssistantMessage ?? [],
        },
      }
      pendingAcknowledgements.set(exec.token, { ...key, runId: record.runId, value })
      return Promise.resolve(json(value))
    },
  }))
}
