import type { CallToolResult } from "@modelcontextprotocol/client"

/** A tool result as JSON: its structured content, or its text parsed as JSON. */
export function toolOutput(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const texts = result.content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  )
  const values = texts.map((text) => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  })
  return values.length === 1 ? values[0] : values
}

/** A failed tool result as {"error":{"code","message",...}}, whatever the server sent. */
export function toolError(result: CallToolResult): {
  error: Record<string, unknown>
} {
  const output = toolOutput(result)
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    const { error } = output as { error?: unknown }
    if (error !== null && typeof error === "object" && !Array.isArray(error))
      return output as { error: Record<string, unknown> }
    return {
      error: {
        code: "TOOL_ERROR",
        message: "The tool failed.",
        details: output,
      },
    }
  }
  return {
    error: {
      code: "TOOL_ERROR",
      message: typeof output === "string" ? output : JSON.stringify(output),
    },
  }
}
