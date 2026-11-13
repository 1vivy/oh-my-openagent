import { dirname, join, sep } from "node:path"

import type { ToolDefinition } from "@code-yeongyu/senpi"
import { log } from "@oh-my-opencode/utils"
import { Type, type Static } from "typebox"

import type { ChildSpec } from "../in-process"
import type { ChildHandle } from "./child-handle"
import type { PrewalkHandoff } from "./prewalk"

// The judge runs in front of the child's start, so its wait is paid by every judged spawn.
const PREWALK_JUDGE_DEADLINE_MS = 15_000
// One same-model retry: the default budget spends longer in backoff than the deadline allows.
const PREWALK_JUDGE_SAME_MODEL_RETRIES = 1
// The assignment is the end of the prompt (loaded skills come first), so the tail is what is kept.
const PREWALK_JUDGE_REQUEST_MAX_CHARS = 8_000

export const PREWALK_ARM_TOOL_NAME = "arm"

const PrewalkArmParams = Type.Object({
  settles: Type.String({ description: "One sentence naming the specific thing the work before the first edit settles." }),
  remaining: Type.String({ description: "One sentence naming the work after the first edit and why none of it needs the strong model." }),
}, { additionalProperties: false })

/** The judge's reasons for arming: what is settled before the first edit, and what is left after it. */
export type PrewalkArmVerdict = Static<typeof PrewalkArmParams>

// The judge's only output channel. Silence is its default answer, so a handoff exists only as an
// accepted call, and a call has to name both halves of the condition it claims.
export const PREWALK_JUDGE_PERSONA = `You are a routing judge attached to one delegated coding assignment. You never carry the assignment out and you never address its author.

A strong model starts the assignment. Your only output channel is the \`arm\` tool: calling it lets a cheaper model continue the same session after the strong model's first edit. Any text you write outside a tool call is discarded.

## Decision

Arm only when both hold:

1. Before the first edit there is real work for a strong model: investigation, diagnosis, or finding a transformation and everything it touches. The assignment says or implies what that work settles.
2. Once that is settled it stays settled. No design decision, trade-off, abstraction, interface, invariant, concurrency or lifecycle question is still open when the first edit lands, and nothing found while implementing or validating is expected to reopen one. What is left is applying a decided change and running the checks.

Size, difficulty, the number of files and needing a plan are not reasons to arm. A question, a read-only request, or a trivial or fully specified edit fails the first condition. Work whose point is to design or realize an abstraction, choose seams, define a guarantee, or chase a cause that may still be unclear after a first look fails the second.

If either condition is in doubt, end the turn without calling the tool. Silence is the correct default: a wrong handoff leaves a weaker model holding an open question and costs the task, while a missed one costs only the price difference.

## arm tool

\`arm(settles, remaining)\`

- \`settles\`: one sentence naming the specific thing the work before the first edit settles.
- \`remaining\`: one sentence naming the work after the first edit and why none of it needs the strong model.

A call that cannot name both is rejected.

## Examples

Assignment: "Exports time out for accounts with more than 10k rows. Find which query the exporter runs and add the missing index."
GOOD: arm("Which exporter query is slow and which index it lacks.", "One migration that adds the index, then the export test.")

Assignment: "Split the \`Scheduler\` class into parts that can be tested; decide the boundaries from how the jobs use it."
GOOD: silence. The boundaries are decided while editing, so the second condition fails.

Assignment: "Change the button label from 'Send' to 'Submit'."
GOOD: silence. There is nothing to settle before the first edit.`

/**
 * Ask the judge whether this assignment's handoff is armed. The answer is an accepted `arm` call
 * or nothing: a silent turn, a refused start, a failed turn and the deadline all leave the child
 * on its own model.
 */
export async function judgePrewalk(
  start: (spec: ChildSpec) => Promise<ChildHandle>,
  spec: ChildSpec,
  handoff: PrewalkHandoff,
): Promise<PrewalkArmVerdict | undefined> {
  const judgeTaskId = `${spec.taskId}-prewalk-judge`
  const { model, thinkingLevel, selectedModel, fallbackModels } = handoff.judge
  let verdict: PrewalkArmVerdict | undefined
  const arm: ToolDefinition = {
    name: PREWALK_ARM_TOOL_NAME,
    label: "Prewalk",
    description: "Let a cheaper model continue this assignment after the strong model's first edit. Call it only when the reasoning is settled by then and stays settled.",
    parameters: PrewalkArmParams,
    execute: async (_toolCallId, input: PrewalkArmVerdict) => {
      if (input.settles.trim().length === 0 || input.remaining.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Rejected: name both what is settled before the first edit and what remains after it, or end the turn." }],
          details: undefined,
          isError: true,
        }
      }
      verdict = { settles: input.settles.trim(), remaining: input.remaining.trim() }
      return { content: [{ type: "text", text: "Armed." }], details: undefined, terminate: true }
    },
  }
  const deadline = Promise.withResolvers<"deadline">()
  const timer = setTimeout(() => deadline.resolve("deadline"), PREWALK_JUDGE_DEADLINE_MS)
  timer.unref?.()
  const started = start({
    taskId: judgeTaskId,
    cwd: spec.cwd,
    // Beside the child's own session directory, where a resume never looks for its transcript.
    sessionDir: `${join(dirname(spec.sessionDir), judgeTaskId)}${sep}`,
    ...(spec.agentDir !== undefined && { agentDir: spec.agentDir }),
    ...(spec.projectTrusted !== undefined && { projectTrusted: spec.projectTrusted }),
    ...(spec.authStorage !== undefined && { authStorage: spec.authStorage }),
    ...(spec.modelRegistry !== undefined && { modelRegistry: spec.modelRegistry }),
    ...(spec.modelRuntime !== undefined && { modelRuntime: spec.modelRuntime }),
    model,
    ...(thinkingLevel !== undefined && { thinkingLevel }),
    selectedModel,
    ...(fallbackModels !== undefined && { fallbackModels }),
    retry: { maxRetries: PREWALK_JUDGE_SAME_MODEL_RETRIES },
    toolAllowlist: [PREWALK_ARM_TOOL_NAME],
    memberScopedToolNames: [PREWALK_ARM_TOOL_NAME],
    memberScopedTools: [arm],
    depth: spec.depth,
    parentSessionId: spec.parentSessionId,
    rootSessionId: spec.rootSessionId,
    systemPrompt: PREWALK_JUDGE_PERSONA,
    promptEnvelope: "bare",
    // A turn that ends without text is a finished turn: the judge's silence is an answer.
    completion: "turn",
    prompt: `<assignment>\n${handoff.request.slice(-PREWALK_JUDGE_REQUEST_MAX_CHARS)}\n</assignment>`,
  })
  let expired = false
  try {
    const settled = await Promise.race([started.then((handle) => handle.waitForIdle()), deadline.promise])
    if (settled === "deadline") {
      expired = true
      return undefined
    }
    // A call accepted before the turn failed is not trusted: only a turn that settled normally arms.
    const armed = settled.status === "completed" ? verdict : undefined
    log("[senpi-task] prewalk judge settled", { taskId: spec.taskId, armed: armed !== undefined, ...armed })
    return armed
  } catch (error) {
    log("[senpi-task] prewalk judge failed; the child stays on its model", { taskId: spec.taskId, error: String(error) })
    return undefined
  } finally {
    clearTimeout(timer)
    // An expired judge is let go without waiting: its turn is aborted and disposed behind the child's start.
    const released = started.then(async (handle) => {
      if (expired) await handle.abort().catch(() => undefined)
      await handle.dispose()
    }).catch(() => undefined)
    if (!expired) await released
  }
}
