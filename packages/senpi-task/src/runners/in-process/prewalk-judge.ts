import { dirname, join, sep } from "node:path"

import { log } from "@oh-my-opencode/utils"

import type { ChildSpec } from "../in-process"
import type { ChildHandle } from "./child-handle"
import type { PrewalkHandoff } from "./prewalk"

export type PrewalkRoute = "prewalk" | "primary" | "direct"

// The judge runs in front of the child's start, so its wait is paid by every judged spawn.
const PREWALK_JUDGE_DEADLINE_MS = 15_000
// One same-model retry: the default budget spends longer in backoff than the deadline allows.
const PREWALK_JUDGE_SAME_MODEL_RETRIES = 1
// The assignment is the end of the prompt (loaded skills come first), so the tail is what is kept.
const PREWALK_JUDGE_REQUEST_MAX_CHARS = 8_000

export const PREWALK_JUDGE_PERSONA = `You route one assignment for a coding agent. You do not carry it out, and you call no tool.

A strong model can start the assignment and a cheaper model can continue the same session after the first edit. That handoff pays off only when both hold: the hard reasoning is finished before the first edit, and it stays finished, so nothing found while implementing or validating sends the work back to it.

Decide where the strong model's reasoning has to be spent, not how hard or how large the assignment is:

- prewalk: starting correctly needs real investigation, diagnosis or design, and once that fixes the approach the implementation and verification left are bounded. Tracing an unfamiliar subsystem before a localized change; reading several interacting files before implementing a clear design; diagnosing a bug down to a concrete fix; a migration whose hard part is finding the transformation and everything it touches.
- primary: strong reasoning stays needed while implementing, debugging or validating. Unresolved races or invariants; subtle state-machine or lifecycle changes; a bug whose cause is likely still unclear after a first look; a trade-off or a contract the assignment leaves open; a hard algorithm; work where the first edit is only the start of the thinking.
- direct: there is no planning phase worth handing off from. A question or a read-only request; a trivial, mechanical or fully specified edit; a tiny localized fix.

A wrong handoff costs more than a missed one. When torn between prewalk and primary, answer primary. A small assignment is direct.

Answer with exactly one word: prewalk, primary or direct.`

/**
 * Ask the judge whether this assignment's handoff is armed. Every miss is `undefined`, and the
 * caller arms on `prewalk` alone: a refused start, a failed or silent turn, an answer that is not
 * one of the three routes, or the deadline all leave the child on its own model.
 */
export async function judgePrewalk(
  start: (spec: ChildSpec) => Promise<ChildHandle>,
  spec: ChildSpec,
  handoff: PrewalkHandoff,
): Promise<PrewalkRoute | undefined> {
  const judgeTaskId = `${spec.taskId}-prewalk-judge`
  const { model, thinkingLevel, selectedModel, fallbackModels } = handoff.judge
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
    toolAllowlist: [],
    depth: spec.depth,
    parentSessionId: spec.parentSessionId,
    rootSessionId: spec.rootSessionId,
    systemPrompt: PREWALK_JUDGE_PERSONA,
    promptEnvelope: "bare",
    prompt: `<assignment>\n${handoff.request.slice(-PREWALK_JUDGE_REQUEST_MAX_CHARS)}\n</assignment>`,
  })
  let expired = false
  try {
    const settled = await Promise.race([started.then((handle) => handle.waitForIdle()), deadline.promise])
    if (settled === "deadline") {
      expired = true
      return undefined
    }
    const route = settled.status === "completed" ? parsePrewalkRoute(settled.finalResponse) : undefined
    log("[senpi-task] prewalk judge answered", { taskId: spec.taskId, route: route ?? "none" })
    return route
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

export function parsePrewalkRoute(answer: string): PrewalkRoute | undefined {
  const word = /^[\s"'`*]*(prewalk|primary|direct)\b/i.exec(answer)?.[1]?.toLowerCase()
  return word === "prewalk" || word === "primary" || word === "direct" ? word : undefined
}
