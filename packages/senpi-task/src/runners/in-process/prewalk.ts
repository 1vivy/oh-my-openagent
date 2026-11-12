import { log } from "@oh-my-opencode/utils"

import type { SenpiThinkingLevel } from "../../senpi/thinking-level"
import type { ChildSession, PrewalkModel } from "./child-handle"

/**
 * A one-shot handoff for an in-process child: the session starts on the category's own model and,
 * at its first edit after the todo list exists, continues on `model` in the same context. The
 * second model inherits what the first one read, the plan as a todo list and one edit in place,
 * so it reads nothing twice.
 */
export type PrewalkTarget = {
  readonly model: PrewalkModel
  readonly thinkingLevel?: SenpiThinkingLevel
}

const TODO_TOOL_NAME = "todo"

// Joined onto the child's task text. The item limit and the per-item check are what keep the
// continuing model on the plan: it can lose the prose, but the todo list is restated to it.
export const PREWALK_PLAN_NUDGE = `<Plan_First>
Before the first edit, read until the approach is settled, then write the complete plan: the remaining steps in execution order with exact files, symbols and commands, and for each step the check that proves it landed. Capture it with the todo tool as 5 to 9 items, one per meaningful code-changing or code-verifying step, each naming its target and its check. Then start the work in the same turn; the plan is a checkpoint, not the answer.
</Plan_First>`

// Steered into the run once the switch is made; it restates the plan's finish checks.
export const PREWALK_CONTINUE_STEER = `The plan is settled and the first edit is in place. Work through the todo list in order and mark each item when its check passes. Before reporting completion: apply a changed pattern at every call site that needs it, keep the diff to what the task requires, and run the checks the plan names.`

/**
 * Arm the handoff on a created child session. Fails open everywhere: a session that cannot switch
 * models, a refused switch or a failed steer leaves the child running on the model it has.
 */
export function armPrewalk(session: ChildSession, target: PrewalkTarget, taskId: string): void {
  const setModel = session.setSessionModel?.bind(session)
  if (setModel === undefined) return
  // Without a todo tool there is no plan to wait for, so the first edit alone decides.
  let planCaptured = session.getActiveToolNames?.().includes(TODO_TOOL_NAME) !== true
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "tool_execution_end" || event.toolName === undefined) return
    if (event.toolName === TODO_TOOL_NAME) {
      if (event.isError !== true) planCaptured = true
      return
    }
    // The same three names the comment checker treats as a file mutation.
    const isEdit = event.toolName === "edit" || event.toolName === "write" || event.toolName === "apply_patch"
    if (!planCaptured || !isEdit) return
    unsubscribe()
    void handOff(session, setModel, target).catch((error: unknown) => {
      log("[senpi-task] prewalk handoff failed; the child stays on its model", { taskId, error: String(error) })
    })
  })
}

// The engine reads the session's model at each turn boundary, so a switch made while this turn's
// tools still run applies to the next provider request of the same run. The engine admits a steer
// one boundary later: the continuing model's first request goes out without it, the second has it.
async function handOff(
  session: ChildSession,
  setModel: NonNullable<ChildSession["setSessionModel"]>,
  target: PrewalkTarget,
): Promise<void> {
  await setModel(target.model)
  if (target.thinkingLevel !== undefined) session.setSessionThinkingLevel?.(target.thinkingLevel)
  await session.steer(PREWALK_CONTINUE_STEER)
}
