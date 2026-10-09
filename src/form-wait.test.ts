import { ProtocolError } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/client"
import { describe, expect, it, vi } from "vite-plus/test"

import { waitForForm } from "./form-wait.ts"
import { SignInRequiredError } from "./errors.ts"
import { server } from "./apps.ts"

const branchId = "11111111-1111-4111-8111-111111111111"
const formId = "22222222-2222-4222-8222-222222222222"

const structured = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
})

/** A clock that moves 45 seconds per call, like the server's long poll. */
function setup(results: Array<CallToolResult | Error>) {
  let time = 0
  const callTool = vi.fn(async () => {
    time += 45_000
    const next = results.shift()
    if (!next) throw new Error("no more results")
    if (next instanceof Error) throw next
    return next
  })
  const progress = vi.fn()
  const options = {
    branchId,
    formId,
    timeoutMs: 30 * 60_000,
    progress,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
  }
  return { callTool, progress, options }
}

describe("waitForForm", () => {
  it("calls cms_wait_for_form until waiting is false", async () => {
    const answers = { waiting: false, formId, answers: { title: "New" } }
    const { callTool, progress, options } = setup([
      structured({ waiting: true, formId }),
      structured({ waiting: true, formId }),
      structured(answers),
    ])
    expect(await waitForForm(callTool, options)).toEqual({
      status: "done",
      result: answers,
    })
    expect(callTool).toHaveBeenCalledTimes(3)
    expect(callTool).toHaveBeenCalledWith(
      "cms_wait_for_form",
      { branchId, formId },
      expect.any(AbortSignal),
    )
    expect(progress).toHaveBeenCalledTimes(2)
  })

  it("uses text content when there is no structured content", async () => {
    const { callTool, options } = setup([
      { content: [{ type: "text", text: '{"waiting":false,"formId":"f"}' }] },
    ])
    expect(await waitForForm(callTool, options)).toEqual({
      status: "done",
      result: { waiting: false, formId: "f" },
    })
  })

  it("times out with the ids to resume", async () => {
    const { callTool, options } = setup(
      Array.from({ length: 100 }, () => structured({ waiting: true, formId })),
    )
    const outcome = await waitForForm(callTool, {
      ...options,
      timeoutMs: 2 * 60_000,
    })
    expect(outcome.status).toBe("timeout")
    expect(outcome).toMatchObject({
      result: { waiting: true, branchId, formId },
    })
    expect(callTool).toHaveBeenCalledTimes(3)
  })

  it("aborts a request that is still running at the deadline", async () => {
    let aborted = false
    const callTool = vi.fn(
      (_name: string, _args: Record<string, unknown>, signal: AbortSignal) =>
        new Promise<CallToolResult>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("The operation was aborted"))
          })
        }),
    )
    const started = Date.now()
    const outcome = await waitForForm(callTool, {
      branchId,
      formId,
      timeoutMs: 50,
      app: "cms",
    })
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(outcome).toMatchObject({
      status: "timeout",
      result: {
        waiting: true,
        message: expect.stringContaining(
          `fulldev cms form wait ${branchId} ${formId}`,
        ),
      },
    })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it("returns a tool error", async () => {
    const { callTool, options } = setup([
      {
        isError: true,
        content: [
          {
            type: "text",
            text: '{"error":{"code":"NOT_FOUND","message":"No form."}}',
          },
        ],
      },
    ])
    expect(await waitForForm(callTool, options)).toEqual({
      status: "error",
      error: { error: { code: "NOT_FOUND", message: "No form." } },
    })
  })

  it("retries a network failure and then continues", async () => {
    const { callTool, progress, options } = setup([
      new TypeError("fetch failed"),
      structured({ waiting: false, formId }),
    ])
    expect((await waitForForm(callTool, options)).status).toBe("done")
    expect(progress).toHaveBeenCalledWith(expect.stringMatching(/retrying/))
  })

  it("gives up after three failures in a row", async () => {
    const { callTool, options } = setup([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ])
    await expect(waitForForm(callTool, options)).rejects.toThrow("fetch failed")
  })

  it.each([
    new SignInRequiredError({ ...server, urlFromFlag: false }),
    new ProtocolError(-32602, "Tool cms_wait_for_form not found"),
  ])("does not retry %s", async (error) => {
    const { callTool, options } = setup([error])
    await expect(waitForForm(callTool, options)).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})
