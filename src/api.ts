import type { Command } from "./args.ts"
import type { Io } from "./main.ts"
import { CliError, SignInRequiredError } from "./errors.ts"
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
  const operations = apiOperations((await specResponse.json()) as Specification)
  if (!command.operation) return operations
  const operation = operations.find(
    (candidate) => candidate.operationId === command.operation,
  )
  if (!operation)
    throw new CliError(
      "NOT_FOUND",
      `Unknown API operation: ${command.operation}. Run fulldev api ${app.name}.`,
    )
  const input = await readToolArguments({
    json: command.json,
    file: command.file,
  })
  const url = new URL(`/${app.name}/api/v1${operation.path}`, origin)
  if (url.origin !== origin || !url.pathname.startsWith(`/${app.name}/api/v1/`))
    throw new CliError(
      "INVALID_API",
      "The server returned an invalid operation path.",
    )
  const reads = operation.method === "GET"
  if (reads)
    for (const [key, value] of Object.entries(input)) {
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
      body: reads ? undefined : JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    })
  }
  let response: Response
  try {
    response = await attempt()
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
    response = await attempt()
  }
  if (response.status === 401) {
    await auth.onUnauthorized({ fetchFn })
    response = await attempt()
  }
  if (response.status === 401) throw new SignInRequiredError(target)
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
    const failure = body as {
      code?: string
      message?: string
      error?: { code?: string; message?: string }
    } | null
    const error = failure?.error ?? failure ?? {}
    throw new CliError(
      error.code ?? "API_FAILED",
      error.message ?? `API request failed (${response.status}).`,
    )
  }
  return body
}
