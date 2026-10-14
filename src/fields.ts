import { CliError, UsageError, exitCodes } from "./errors.ts"

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

/**
 * --raw: the text at `field` of a successful request's result. When it is
 * not text, the error says the request succeeded and keeps its result, such
 * as a new page's id, so nobody sends a change twice.
 */
export function rawText(
  result: unknown,
  field: Field,
  readOnly: boolean,
): string {
  let current = result
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
  const name = fieldName(field)
  throw new CliError(
    "RAW_NOT_TEXT",
    `The request succeeded${readOnly ? "" : " and any change it made is kept"}, but --raw ${name} needs text, and the result's ${name} is ${kind}. The full result is under "result"${readOnly ? "." : "; do not send the request again."}`,
    exitCodes.error,
    { succeeded: true, result },
  )
}

const article = (type: string) =>
  type === "null" ? "null" : /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`

/** A local reference such as #/$defs/page or #/components/schemas/Page. */
function resolve(root: unknown, ref: string): unknown {
  if (ref !== "#" && !ref.startsWith("#/")) return undefined
  let node = root
  for (const part of ref === "#" ? [] : ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~")
    if ((!isRecord(node) && !Array.isArray(node)) || !Object.hasOwn(node, key))
      return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/**
 * Why a declared output schema rules out text at `field`, or undefined when
 * it may be text. It trusts only what the schema proves: types, properties
 * closed with additionalProperties false, array items, local $refs, and
 * unions whose every branch rules it out. An open object, a pattern or an
 * unknown keyword may hold text.
 */
export function ruledOutText(
  schema: unknown,
  field: Field,
  root: unknown = schema,
): string | undefined {
  // Bounds reference cycles; running out means "may be text".
  let budget = 200
  const visit = (node: unknown, position: number): string | undefined => {
    if (--budget < 0 || !isRecord(node)) return undefined
    if (typeof node.$ref === "string")
      return visit(resolve(root, node.$ref), position)
    if (Array.isArray(node.allOf)) {
      const ruled = node.allOf
        .map((branch) => visit(branch, position))
        .find((reason) => reason !== undefined)
      if (ruled) return ruled
    }
    for (const branches of [node.anyOf, node.oneOf]) {
      if (!Array.isArray(branches) || branches.length === 0) continue
      const reasons = branches.map((branch) => visit(branch, position))
      if (reasons.every((reason) => reason !== undefined)) return reasons[0]
    }
    const types =
      typeof node.type === "string"
        ? [node.type]
        : Array.isArray(node.type)
          ? node.type.filter((type): type is string => typeof type === "string")
          : undefined
    const at = fieldName(field.slice(0, position)) || "the result"
    const is = () => `${at} is ${types!.map(article).join(" or ")}`
    const segment = field[position]
    if (segment === undefined)
      return types && !types.includes("string") ? is() : undefined
    const reasons: Array<string | undefined> = []
    if (!types || types.includes("object")) {
      const properties = isRecord(node.properties) ? node.properties : {}
      const composed = ["allOf", "anyOf", "oneOf", "patternProperties"].some(
        (key) => node[key] !== undefined,
      )
      reasons.push(
        Object.hasOwn(properties, segment)
          ? visit(properties[segment], position + 1)
          : composed
            ? undefined
            : node.additionalProperties === false
              ? `${at} has no ${segment}`
              : visit(node.additionalProperties, position + 1),
      )
    }
    if (index.test(segment) && (!types || types.includes("array"))) {
      const item = Number(segment)
      const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : []
      reasons.push(
        item < prefix.length
          ? visit(prefix[item], position + 1)
          : node.items === false
            ? `${at} has no item ${segment}`
            : visit(node.items, position + 1),
      )
    }
    if (reasons.length === 0) return `${is()}, so it has no ${segment}`
    return reasons.every((reason) => reason !== undefined)
      ? reasons[0]
      : undefined
  }
  return visit(schema, 0)
}
