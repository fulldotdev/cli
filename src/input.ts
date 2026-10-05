import { readFile } from "node:fs/promises"
import { text } from "node:stream/consumers"

import { UsageError } from "./args.ts"

export interface ToolInputSource {
  /** The JSON argument; "-" reads stdin. */
  json?: string | undefined
  file?: string | undefined
  readStdin?: () => Promise<string>
}

/** Reads a tool's arguments: a JSON object from the argument, a file or stdin. */
export async function readToolArguments({
  json,
  file,
  readStdin = () => text(process.stdin),
}: ToolInputSource): Promise<Record<string, unknown>> {
  if (json !== undefined && file !== undefined)
    throw new UsageError(
      "Give the JSON as an argument or with --file, not both.",
    )
  let source = "{}"
  let from = "the argument"
  if (file !== undefined) {
    from = file
    try {
      source = await readFile(file, "utf8")
    } catch (error) {
      throw new UsageError(
        `Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      )
    }
  } else if (json === "-") {
    from = "stdin"
    source = await readStdin()
  } else if (json !== undefined) source = json
  if (!source.trim()) source = "{}"

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new UsageError(
      `The tool input from ${from} is not valid JSON: ${(error as Error).message}`,
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError(`The tool input from ${from} must be a JSON object.`)
  return value as Record<string, unknown>
}
