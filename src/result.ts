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

/** A failed tool result as an error object, also when the server sent plain text. */
export function toolError(result: CallToolResult): unknown {
  const output = toolOutput(result)
  return output !== null && typeof output === "object" && !Array.isArray(output)
    ? output
    : { error: { code: "TOOL_ERROR", message: output } }
}
