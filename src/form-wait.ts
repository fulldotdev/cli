import { ProtocolError } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/client"

import { isLoginRequired } from "./oauth.ts"
import { toolError, toolOutput } from "./result.ts"

/** The one tool the CLI names itself. */
export const waitTool = "wait_for_form"

export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<CallToolResult>

export interface FormWaitOptions {
  branchId: string
  formId: string
  timeoutMs: number
  progress?: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type FormWaitOutcome =
  | { status: "done"; result: unknown }
  | { status: "error"; error: unknown }
  | { status: "timeout"; result: Record<string, unknown> }

const maxFailures = 3
const retryMs = 5_000

function minutes(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/**
 * Calls wait_for_form while it answers waiting true. Each call waits on the
 * server, so the loop does not sleep between rounds. Network failures are
 * retried a few times; tool and protocol errors end the wait.
 */
export async function waitForForm(
  callTool: CallTool,
  {
    branchId,
    formId,
    timeoutMs,
    progress = () => {},
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: FormWaitOptions,
): Promise<FormWaitOutcome> {
  const deadline = now() + timeoutMs
  let failures = 0
  for (let round = 1; now() < deadline; round++) {
    let result: CallToolResult
    try {
      result = await callTool(waitTool, { branchId, formId })
      failures = 0
    } catch (error) {
      if (
        isLoginRequired(error) ||
        error instanceof ProtocolError ||
        ++failures >= maxFailures
      )
        throw error
      progress(`The request failed (${(error as Error).message}); retrying.`)
      await sleep(retryMs)
      continue
    }
    if (result.isError) return { status: "error", error: toolError(result) }
    const output = toolOutput(result)
    const waiting =
      output !== null &&
      typeof output === "object" &&
      (output as { waiting?: unknown }).waiting === true
    if (!waiting) return { status: "done", result: output }
    progress(
      `Waiting for the person to send the form (round ${round}, ${minutes(deadline - now())} left).`,
    )
  }
  return {
    status: "timeout",
    result: {
      waiting: true,
      branchId,
      formId,
      message: `Stopped waiting after ${minutes(timeoutMs)}. Run fulldev form wait ${branchId} ${formId} to keep waiting, or continue when the person says they are done.`,
    },
  }
}
