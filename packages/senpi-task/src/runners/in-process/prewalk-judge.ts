import { log } from "@oh-my-opencode/utils"

import type { PrewalkHandoff, PrewalkRegistry } from "./prewalk"

// A judgment slower than this gives way to the unjudged start: an optimization never holds a spawn.
const PREWALK_JUDGE_TIMEOUT_MS = 4_000
// The assignment is the end of the prompt (loaded skills come first), so the tail is what is kept.
const PREWALK_JUDGE_REQUEST_MAX_CHARS = 16_000

const INTRODUCTION = "The state is one delegated coding assignment. A strong model starts it; arming lets a cheaper model continue the same session after the strong model's first edit."

// Two questions, one for each half of the condition, answered on their own. A handoff pays off
// only when the hard reasoning is finished before the first edit AND stays finished; asked as one
// question, the second half is the one a classifier gives away.
const PREWALK_JUDGE_QUESTIONS = {
  settles_first: {
    type: "bool",
    instructions: `${INTRODUCTION}\n\nDoes starting correctly need real investigation, diagnosis, or finding a transformation and everything it touches before the first edit?`,
    criteria: {
      true: "The approach has to be found by reading or diagnosing before anything is edited.",
      false: "A question, a read-only request, or a trivial, mechanical or fully specified edit.",
    },
  },
  may_reopen: {
    type: "bool",
    instructions: `${INTRODUCTION}\n\nAfter the first edit, is hard reasoning likely still needed?`,
    criteria: {
      true: "An open design decision, trade-off, abstraction or interface; a race, invariant, state-machine or lifecycle question; a cause that may still be unclear after a first look; a hard algorithm.",
      false: "The rest is applying a decided change and running checks.",
    },
  },
} as const

/**
 * Ask the classifier whether this assignment's handoff is armed. It arms only on two answers that
 * clear their cut-offs: a missing credential, a failed or late judgment, and a malformed answer all
 * leave the child on its own model.
 */
export async function judgePrewalk(registry: PrewalkRegistry, handoff: PrewalkHandoff, taskId: string): Promise<boolean> {
  const result = await registry.classify(
    handoff.judge.model,
    { state: { assignment: handoff.request.slice(-PREWALK_JUDGE_REQUEST_MAX_CHARS) }, questions: PREWALK_JUDGE_QUESTIONS },
    { signal: AbortSignal.timeout(PREWALK_JUDGE_TIMEOUT_MS) },
  )
  const settles = result.answers.settles_first
  const reopens = result.answers.may_reopen
  if (result.stopReason !== "stop" || settles?.type !== "bool" || reopens?.type !== "bool") {
    log("[senpi-task] prewalk judge gave no answer; the child stays on its model", { taskId, stopReason: result.stopReason, error: result.errorMessage })
    return false
  }
  const armed = settles.probability >= handoff.judge.settlesMin && reopens.probability <= handoff.judge.reopenMax
  log("[senpi-task] prewalk judged", { taskId, armed, settles_first: settles.probability, may_reopen: reopens.probability })
  return armed
}
