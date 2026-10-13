import { CliError, UsageError } from "./errors.ts"

/** A field of a JSON value by its dotted path, such as content.blocks.0.markdown. */
export type Field = Array<string>

/** Names that would reach an object's prototype instead of its own data. */
const unsafe = new Set(["__proto__", "prototype", "constructor"])

const index = /^(?:0|[1-9]\d*)$/

export const fieldName = (field: Field) => field.join(".")

export function parseField(text: string, flag: string): Field {
  const field = text.split(".")
  if (field.some((segment) => segment === ""))
    throw new UsageError(
      `${flag} needs a field such as content or changes.0.content, not "${text}".`,
    )
  const bad = field.find((segment) => unsafe.has(segment))
  if (bad) throw new UsageError(`${flag} cannot use the field name ${bad}.`)
  return field
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Sets `text` at `field` of the tool input. Objects on the way are created
 * when missing; arrays must already be there. A field the input already has
 * is a conflict: the person names each field once.
 */
export function setText(
  input: Record<string, unknown>,
  field: Field,
  text: string,
) {
  const name = fieldName(field)
  const fail = (reason: string): never => {
    throw new UsageError(`Cannot set --text-file ${name}: ${reason}`)
  }
  let container: unknown = input
  for (const [position, segment] of field.entries()) {
    const last = position === field.length - 1
    const at = fieldName(field.slice(0, position + 1))
    if (Array.isArray(container)) {
      if (last) fail(`${at} is an array element; set a field inside it.`)
      if (!index.test(segment) || Number(segment) >= container.length)
        fail(`${fieldName(field.slice(0, position))} has no item ${segment}.`)
      container = container[Number(segment)]
      continue
    }
    if (!isRecord(container))
      return fail(`${fieldName(field.slice(0, position))} is not an object.`)
    if (last) {
      if (Object.hasOwn(container, segment))
        fail(`the input already has ${at}. Leave it out of the JSON.`)
      container[segment] = text
      return
    }
    if (!Object.hasOwn(container, segment)) {
      if (index.test(field[position + 1]!))
        fail(`${at} is missing; give the array in the JSON input.`)
      container[segment] = {}
    }
    container = container[segment]
  }
}

/** The text at `field` of a result, or an error that names what is there. */
export function getText(value: unknown, field: Field): string {
  let current = value
  for (const segment of field) {
    current =
      Array.isArray(current) && index.test(segment)
        ? current[Number(segment)]
        : isRecord(current) && Object.hasOwn(current, segment)
          ? current[segment]
          : undefined
    if (current === undefined) break
  }
  if (typeof current === "string") return current
  const kind =
    current === undefined
      ? "missing"
      : current === null
        ? "null"
        : Array.isArray(current)
          ? "an array"
          : typeof current === "object"
            ? "an object"
            : `a ${typeof current}`
  throw new CliError(
    "RAW_NOT_TEXT",
    `--raw ${fieldName(field)} needs text in the result, and it is ${kind}.`,
  )
}
