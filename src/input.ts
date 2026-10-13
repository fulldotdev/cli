import { readFile } from "node:fs/promises"
import { buffer } from "node:stream/consumers"

import { UsageError } from "./errors.ts"
import { fieldName, parseField, setText } from "./fields.ts"
import type { Field } from "./fields.ts"

/** --text-file <field>=<path>: a file's exact text as one field of the input. */
export interface TextFile {
  field: Field
  /** The file, or "-" for stdin. */
  path: string
}

export interface ToolInputSource {
  /** The JSON argument; "-" reads stdin. */
  json?: string | undefined
  file?: string | undefined
  textFiles?: Array<TextFile> | undefined
  readStdin?: () => Promise<Uint8Array>
}

/** Strict UTF-8 that keeps a byte order mark, so the text stays exactly as written. */
const exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Parses the --text-file flags; each field once, and stdin for one input only. */
export function parseTextFiles(
  specs: Array<string>,
  json: string | undefined,
): Array<TextFile> {
  const textFiles = specs.map((spec) => {
    const split = spec.indexOf("=")
    if (split <= 0 || split === spec.length - 1)
      throw new UsageError(
        `--text-file needs <field>=<path>, such as content=page.md, not "${spec}".`,
      )
    return {
      field: parseField(spec.slice(0, split), "--text-file"),
      path: spec.slice(split + 1),
    }
  })
  for (const [position, { field }] of textFiles.entries())
    for (const other of textFiles.slice(position + 1)) {
      const [short, long] =
        field.length <= other.field.length
          ? [field, other.field]
          : [other.field, field]
      if (short.every((segment, at) => segment === long[at]))
        throw new UsageError(
          short.length === long.length
            ? `--text-file names ${fieldName(short)} twice.`
            : `--text-file sets ${fieldName(short)} and ${fieldName(long)}, which is inside it.`,
        )
    }
  const stdin = textFiles.filter(({ path }) => path === "-").length
  if (stdin + (json === "-" ? 1 : 0) > 1)
    throw new UsageError(
      "Only one input can come from stdin: the JSON with - or one --text-file.",
    )
  return textFiles
}

/** A text file's exact content; no trimming and no newline changes. */
async function readText(path: string, readStdin: () => Promise<Uint8Array>) {
  let bytes: Uint8Array
  if (path === "-") bytes = await readStdin()
  else
    try {
      bytes = await readFile(path)
    } catch (error) {
      throw new UsageError(
        `Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      )
    }
  try {
    return exact.decode(bytes)
  } catch {
    throw new UsageError(
      `${path === "-" ? "stdin" : path} is not valid UTF-8 text.`,
    )
  }
}

/**
 * Reads a tool's arguments: a JSON object from the argument, a file or stdin,
 * with the exact text of each --text-file in its field.
 */
export async function readToolArguments({
  json,
  file,
  textFiles = [],
  readStdin = () => buffer(process.stdin),
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
    source = new TextDecoder().decode(await readStdin())
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
  const input = value as Record<string, unknown>

  for (const { field, path } of textFiles)
    setText(input, field, await readText(path, readStdin))
  return input
}
