#!/usr/bin/env node
import {
  Client,
  ProtocolError,
  SdkError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import type { Tool } from "@modelcontextprotocol/client"

import pkg from "../package.json" with { type: "json" }
import { help, parseCommandLine, UsageError } from "./args.ts"
import type { CommandLine } from "./args.ts"
import { CredentialStore } from "./credentials.ts"
import { waitForForm } from "./form-wait.ts"
import { readToolArguments } from "./input.ts"
import {
  CliOAuthProvider,
  LoginRequiredError,
  isLoginRequired,
  login,
} from "./oauth.ts"
import { toolError, toolOutput } from "./result.ts"

const exit = { error: 1, timeout: 2, login: 3 } as const

const print = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
const printError = (value: unknown) =>
  process.stderr.write(`${JSON.stringify(value, null, 2)}\n`)
const hint = (line: string) => process.stderr.write(`${line}\n`)

/** A tool call can wait on the server for up to a minute. */
const requestTimeoutMs = 120_000

async function connect(serverUrl: string, store: CredentialStore) {
  if (!(await store.get()).tokens) throw new LoginRequiredError(serverUrl)
  const client = new Client({ name: "fulldev-cli", version: pkg.version })
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: new CliOAuthProvider(store),
  })
  try {
    await client.connect(transport, { timeout: requestTimeoutMs })
  } catch (error) {
    throw signInError(error, serverUrl)
  }
  return client
}

/** A rejected or expired sign-in, from any layer, becomes LoginRequiredError. */
function signInError(error: unknown, serverUrl: string) {
  if (isLoginRequired(error)) return error
  if (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && /401|unauthori[sz]ed/i.test(error.message))
  )
    return new LoginRequiredError(serverUrl)
  return error
}

/** Runs an action with a connected client, signing in first when allowed. */
async function withClient<T>(
  line: CommandLine,
  store: CredentialStore,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const attempt = async () => {
    const client = await connect(line.url, store)
    try {
      return await action(client)
    } catch (error) {
      throw signInError(error, line.url)
    } finally {
      await client.close().catch(() => {})
    }
  }
  try {
    return await attempt()
  } catch (error) {
    if (!isLoginRequired(error) || !line.login) throw error
    hint(`Not signed in to ${line.url}.`)
    await login(line.url, store, { browser: line.browser, log: hint })
    return attempt()
  }
}

async function listTools(client: Client) {
  const tools: Array<Tool> = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

function claims(token: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
    )
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function status(line: CommandLine, store: CredentialStore) {
  const base = { server: line.url, credentials: store.path }
  if (!(await store.get()).tokens) {
    print({ ...base, signedIn: false })
    return exit.login
  }
  let server
  try {
    const client = await connect(line.url, store)
    server = client.getServerVersion()
    await client.close()
  } catch (error) {
    if (!isLoginRequired(error)) throw error
    print({ ...base, signedIn: true, valid: false })
    return exit.login
  }
  const { tokens, savedAt } = await store.get()
  const access = claims(tokens?.access_token)
  const identity = claims(tokens?.id_token)
  const expires =
    typeof access.exp === "number"
      ? access.exp * 1000
      : savedAt && tokens?.expires_in
        ? savedAt + tokens.expires_in * 1000
        : undefined
  print({
    ...base,
    signedIn: true,
    valid: true,
    email: identity.email,
    name: identity.name,
    userId: access.sub ?? identity.sub,
    organizationId: access.org_id,
    expiresAt: expires ? new Date(expires).toISOString() : undefined,
    serverName: server?.title ?? server?.name,
    serverVersion: server?.version,
  })
  return 0
}

async function run(line: CommandLine): Promise<number> {
  if (line.version) {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  if (!line.command || line.help || line.command === "help") {
    process.stdout.write(help)
    return 0
  }
  const store = new CredentialStore(line.url)
  const [first, second, third] = line.args

  switch (line.command) {
    case "login":
      await login(line.url, store, { browser: line.browser, log: hint })
      hint("Signed in.")
      return status(line, store)
    case "logout":
      await store.update(({ client }) => (client ? { client } : {}))
      print({ server: line.url, signedIn: false })
      return 0
    case "status":
      return status(line, store)
    case "instructions": {
      const text = await withClient(line, store, async (client) =>
        client.getInstructions(),
      )
      if (!text) hint("The server sent no instructions.")
      else process.stdout.write(`${text}\n`)
      return 0
    }
    case "tools": {
      const tools = await withClient(line, store, listTools)
      if (!first) {
        print(
          tools.map((tool) => ({
            name: tool.name,
            title: tool.title ?? tool.annotations?.title,
            description: tool.description?.split("\n")[0],
          })),
        )
        hint("Run fulldev tools <name> for a tool's input schema.")
        return 0
      }
      const tool = tools.find((candidate) => candidate.name === first)
      if (!tool) {
        printError({
          error: { code: "NOT_FOUND", message: `No tool named ${first}.` },
        })
        return exit.error
      }
      print({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })
      return 0
    }
    case "call": {
      const args = await readToolArguments({ json: second, file: line.file })
      const result = await withClient(line, store, (client) =>
        client.callTool(
          { name: first!, arguments: args },
          { timeout: requestTimeoutMs },
        ),
      )
      if (result.isError) {
        printError(toolError(result))
        return exit.error
      }
      print(toolOutput(result))
      return 0
    }
    case "form": {
      const outcome = await withClient(line, store, (client) =>
        waitForForm(
          (name, args) =>
            client.callTool(
              { name, arguments: args },
              { timeout: requestTimeoutMs },
            ),
          {
            branchId: second!,
            formId: third!,
            timeoutMs: line.timeoutMinutes * 60_000,
            progress: hint,
          },
        ),
      )
      if (outcome.status === "error") {
        printError(outcome.error)
        return exit.error
      }
      print(outcome.result)
      return outcome.status === "timeout" ? exit.timeout : 0
    }
  }
  throw new UsageError(`Unknown command: ${line.command}`)
}

async function main() {
  try {
    process.exitCode = await run(parseCommandLine(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof UsageError) {
      hint(`${error.message}\nRun fulldev help for usage.`)
      process.exitCode = exit.error
    } else if (isLoginRequired(error)) {
      printError({
        error: { code: "UNAUTHORIZED", message: (error as Error).message },
      })
      process.exitCode = exit.login
    } else {
      printError({
        error: {
          code:
            error instanceof ProtocolError
              ? error.code
              : error instanceof Error
                ? error.name
                : "ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      })
      process.exitCode = exit.error
    }
  }
}

await main()
