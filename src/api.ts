import type { Command } from "./args.ts"
import type { Io } from "./main.ts"
import {
  CliError,
  SignInRequiredError,
  UsageError,
  exitCodes,
} from "./errors.ts"
import { fieldName, rawText, ruledOutText } from "./fields.ts"
import { readToolArguments } from "./input.ts"
import { StoredTokenAuth, browserLogin } from "./oauth.ts"

interface Parameter {
  name: string
  in: string
}
interface Operation {
  operationId?: string
  summary?: string
  parameters?: Array<Parameter>
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>
}
interface Specification {
  paths?: Record<string, Record<string, Operation>>
}

export function apiOperations(spec: Specification) {
  return Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) =>
        ["get", "post", "put", "patch", "delete"].includes(method),
      )
      .map(([method, operation]) => ({
        path,
        method: method.toUpperCase(),
        ...operation,
      })),
  )
}

/** All HTTP operations from the server's specification, independent of its MCP tool selection. */
export async function runApi(
  command: Extract<Command, { kind: "api" }>,
  io: Io,
  fetchFn: typeof fetch = fetch,
) {
  const { target, app } = command
  const origin = new URL(target.url).origin
  const specResponse = await fetchFn(`${origin}/${app.name}/api/openapi.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!specResponse.ok)
    throw new CliError(
      "API_UNAVAILABLE",
      "This server does not expose the app's OpenAPI specification.",
    )
  const spec = (await specResponse.json()) as Specification
  const operations = apiOperations(spec)
  if (!command.operation) return operations
  const operation = operations.find(
    (candidate) => candidate.operationId === command.operation,
  )
  if (!operation)
    throw new CliError(
      "NOT_FOUND",
      `Unknown API operation: ${command.operation}. Run fulldev api ${app.name}.`,
    )
  const { raw } = command
  if (raw) {
    // Before anything is sent: does every success response rule out text?
    const reasons = Object.entries(operation.responses ?? {})
      .filter(([status]) => status.startsWith("2"))
      .map(([, response]) =>
        ruledOutText(response.content?.["application/json"]?.schema, raw, spec),
      )
    if (reasons.length > 0 && reasons.every((reason) => reason !== undefined))
      throw new UsageError(
        `--raw ${fieldName(raw)} can never be text: the API's response schema says ${reasons[0]}. Nothing was sent.`,
        `fulldev api ${app.name}`,
      )
  }
  const input = await readToolArguments({
    json: command.json,
    file: command.file,
    textFiles: command.textFiles,
  })
  const payload = { ...input }
  const path = operation.path.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = input[name]
    if (
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean") ||
      value === "" ||
      value === "." ||
      value === ".."
    )
      throw new CliError(
        "INVALID_INPUT",
        `Provide a scalar value for path parameter: ${name}.`,
      )
    delete payload[name]
    return encodeURIComponent(String(value))
  })
  const url = new URL(`/${app.name}/api/v1${path}`, origin)
  if (url.origin !== origin || !url.pathname.startsWith(`/${app.name}/api/v1/`))
    throw new CliError(
      "INVALID_API",
      "The server returned an invalid operation path.",
    )
  const reads = operation.method === "GET"
  if (reads)
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue
      if (Array.isArray(value))
        value.forEach((part) =>
          url.searchParams.append(
            key,
            typeof part === "string" ? part : JSON.stringify(part),
          ),
        )
      else
        url.searchParams.set(
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        )
    }
  const auth = new StoredTokenAuth(target, io.store)
  const attempt = async () => {
    const token = await auth.token()
    if (!token) throw new SignInRequiredError(target)
    const headers = new Headers({ authorization: `Bearer ${token}` })
    if (command.organization)
      headers.set("x-fulldev-organization", command.organization)
    if (!reads) headers.set("content-type", "application/json")
    return fetchFn(url, {
      method: operation.method,
      headers,
      body: reads ? undefined : JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    })
  }
  const authenticated = async () => {
    let response = await attempt()
    if (response.status === 401) {
      await auth.onUnauthorized({ fetchFn })
      response = await attempt()
    }
    if (response.status === 401) throw new SignInRequiredError(target)
    return response
  }
  let response: Response
  try {
    response = await authenticated()
  } catch (error) {
    if (
      !(error instanceof SignInRequiredError) ||
      !io.interactive ||
      !command.session.login
    )
      throw error
    await browserLogin(target, io.store, {
      browser: command.session.browser,
      log: (line) => io.stderr(`${line}\n`),
    })
    response = await authenticated()
  }
  const body: unknown =
    response.status === 204
      ? null
      : await response.json().catch(() => {
          throw new CliError(
            "API_FAILED",
            `API returned a non-JSON response (${response.status}).`,
          )
        })
  if (!response.ok) {
    // {"error":{...}} from the server, or an oRPC error with its data, such as
    // a conflict's current version: everything but code and message stays.
    const record = (value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
    const {
      code,
      message,
      defined: _defined,
      ...details
    } = record(record(body)?.error) ?? record(body) ?? {}
    throw new CliError(
      typeof code === "string" ? code : "API_FAILED",
      typeof message === "string"
        ? message
        : `API request failed (${response.status}).`,
      exitCodes.error,
      { ...details, status: response.status },
    )
  }
  return raw ? rawText(body, raw, reads) : body
}
