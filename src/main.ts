import {
  Client,
  SdkError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import type { Tool } from "@modelcontextprotocol/client"

import pkg from "../package.json" with { type: "json" }
import { helpText, parseCommandLine } from "./args.ts"
import type { Command, Session } from "./args.ts"
import type { CredentialStore } from "./credentials.ts"
import {
  CliError,
  SignInRequiredError,
  UsageError,
  describeError,
  exitCodes,
  isSignInRequired,
} from "./errors.ts"
import { waitForForm } from "./form-wait.ts"
import { readToolArguments } from "./input.ts"
import {
  StoredTokenAuth,
  browserLogin,
  expiresAt,
  revokeTokens,
} from "./oauth.ts"
import { toolName } from "./apps.ts"
import type { App, Target } from "./apps.ts"
import { toolError, toolOutput } from "./result.ts"

/** Where the CLI writes, and whether a person is at the terminal. */
export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  interactive: boolean
  env: NodeJS.ProcessEnv
  store: CredentialStore
}

/** A tool call can wait on the server for up to a minute. */
const requestTimeoutMs = 120_000

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** A rejected or expired sign-in, from any layer, becomes SignInRequiredError. */
function signInError(error: unknown, target: Target) {
  if (isSignInRequired(error)) return error
  if (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError &&
      /\b401\b|unauthori[sz]ed/i.test(error.message))
  )
    return new SignInRequiredError(target)
  return error
}

async function connect(target: Target, io: Io) {
  if (!(await io.store.get(target.url)).tokens)
    throw new SignInRequiredError(target)
  const client = new Client({ name: "fulldev-cli", version: pkg.version })
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    authProvider: new StoredTokenAuth(target, io.store),
  })
  try {
    await client.connect(transport, { timeout: requestTimeoutMs })
  } catch (error) {
    throw signInError(error, target)
  }
  return client
}

/**
 * Runs an action with a connected client. When a sign-in is needed it starts
 * one in the browser only for a person at a terminal; otherwise it fails at
 * once with exit code 3.
 */
async function withClient<T>(
  target: Target,
  session: Session,
  io: Io,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const attempt = async () => {
    const client = await connect(target, io)
    try {
      return await action(client)
    } catch (error) {
      throw signInError(error, target)
    } finally {
      await client.close().catch(() => {})
    }
  }
  try {
    return await attempt()
  } catch (error) {
    if (!isSignInRequired(error) || !session.login || !io.interactive)
      throw error
    io.stderr(`Not signed in to ${target.title}.\n`)
    await browserLogin(target, io.store, {
      browser: session.browser,
      log: (line) => io.stderr(`${line}\n`),
    })
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

/** The server's own tool that lists the organizations of the sign-in. */
const organizationsTool = "fulldev_list_organizations"

interface Organization {
  id: string
  slug: string
  name: string
  apps: Array<string>
}

/** The organizations of the sign-in, with the apps the person may use in each. */
async function listOrganizations(client: Client) {
  const result = await client.callTool(
    { name: organizationsTool, arguments: {} },
    { timeout: requestTimeoutMs },
  )
  if (result.isError)
    throw new CliError("ERROR", JSON.stringify(toolError(result)))
  const { organizations } = toolOutput(result) as {
    organizations?: Array<Organization>
  }
  return organizations ?? []
}

/** The sign-in, and whether the server still accepts it. */
async function signInStatus(target: Target, io: Io) {
  const { credentials, storage } = await io.store.read(target.url)
  const base = { server: target.url }
  if (!credentials.tokens) return { ...base, signedIn: false }
  // valid: the server accepts the sign-in; unknown (with error) when it could not be checked.
  let valid: boolean | undefined = true
  let error: string | undefined
  let organizations: Array<Organization> | undefined
  try {
    const client = await connect(target, io)
    try {
      organizations = await listOrganizations(client)
    } catch (cause) {
      error = `The organizations could not be listed: ${(cause as Error).message}`
    } finally {
      await client.close().catch(() => {})
    }
  } catch (cause) {
    if (isSignInRequired(cause)) valid = false
    else {
      valid = undefined
      error = (cause as Error).message
    }
  }
  const current = await io.store.get(target.url)
  const expires = expiresAt(current)
  return {
    ...base,
    signedIn: Boolean(current.tokens),
    valid,
    ...(error ? { error } : {}),
    email: current.email,
    organizations: organizations?.map(({ slug, name, apps }) => ({
      slug,
      name,
      apps,
    })),
    expiresAt: expires ? new Date(expires).toISOString() : undefined,
    storage,
  }
}

async function status(target: Target, io: Io) {
  const result = await signInStatus(target, io)
  const storage = await io.store.storage()
  io.stdout(
    json({
      ...result,
      storage:
        storage === "keychain"
          ? { kind: "keychain", service: "fulldev" }
          : {
              kind: "file",
              path: io.store.filePath,
              reason: `The OS keychain is unavailable: ${io.store.keychainError}`,
            },
    }),
  )
  if (!result.signedIn || ("valid" in result && result.valid === false))
    return exitCodes.signIn
  return "error" in result ? exitCodes.error : exitCodes.ok
}

async function logout(target: Target, io: Io) {
  const credentials = await io.store.get(target.url)
  if (!credentials.tokens && !credentials.client) {
    io.stdout(json({ server: target.url, signedIn: false }))
    return exitCodes.ok
  }
  const revocation = await revokeTokens(target, credentials)
  if (!revocation.revoked)
    io.stderr(
      `Could not revoke the tokens of ${target.title}: ${revocation.error} They are deleted from this computer anyway.\n`,
    )
  await io.store.update(target.url, () => ({}))
  io.stdout(
    json({
      server: target.url,
      signedIn: false,
      revoked: revocation.revoked,
      ...(revocation.error ? { revocationError: revocation.error } : {}),
    }),
  )
  return exitCodes.ok
}

/**
 * The part of the server's instructions for one app: the overview before
 * the first app, and the app's own, under its heading `## <title> (<app>_)`.
 */
export function instructionsFor(text: string, app: App) {
  const [overview = "", ...sections] = text.split(/\n(?=## )/)
  const own = sections.find((section) =>
    section.split("\n")[0]!.endsWith(`(${app.name}_)`),
  )
  if (!own)
    throw new CliError(
      "APP_NOT_AVAILABLE",
      `${app.title} is not among your apps in the organizations of this sign-in. Run fulldev status for the apps you may use in each, or fulldev login to choose other organizations.`,
    )
  return `${overview.trimEnd()}\n\n${own.trim()}`
}

/**
 * Calls a tool that only reads once in every organization of the sign-in
 * whose apps include the tool's app, and prints every answer together.
 */
async function callInEvery(
  command: Extract<Command, { kind: "call" }>,
  args: Record<string, unknown>,
  io: Io,
) {
  const answers = await withClient(
    command.target,
    command.session,
    io,
    async (client) => {
      const tool = (await listTools(client)).find(
        ({ name }) => name === command.tool,
      )
      if (!tool)
        throw new CliError(
          "NOT_FOUND",
          `You have no tool named ${command.tool}. Run fulldev tools for the list.`,
        )
      if (tool.annotations?.readOnlyHint !== true)
        throw new UsageError(
          `--all-orgs calls only tools that only read, and ${command.tool} changes data. Name one organization with --org.`,
          "fulldev help call",
        )
      const app = command.tool.split("_")[0]!
      const organizations = (await listOrganizations(client)).filter(
        ({ apps }) => apps.includes(app),
      )
      return Promise.all(
        organizations.map(async ({ slug, name }) => {
          const organization = { slug, name }
          try {
            const result = await client.callTool(
              {
                name: command.tool,
                arguments: { ...args, organization: slug },
              },
              { timeout: requestTimeoutMs },
            )
            return result.isError
              ? { organization, ...toolError(result) }
              : { organization, result: toolOutput(result) }
          } catch (error) {
            if (isSignInRequired(error)) throw error
            return { organization, ...describeError(error).body }
          }
        }),
      )
    },
  )
  io.stdout(json({ organizations: answers }))
  return answers.some((answer) => "error" in answer)
    ? exitCodes.error
    : exitCodes.ok
}

async function run(command: Command, io: Io): Promise<number> {
  const log = (line: string) => io.stderr(`${line}\n`)
  switch (command.kind) {
    case "version":
      io.stdout(`${pkg.version}\n`)
      return exitCodes.ok
    case "help":
      io.stdout(helpText(command.topic) ?? "")
      return exitCodes.ok
  }

  switch (command.kind) {
    case "login": {
      const { target } = command
      // A new sign-in, such as one to switch organization, replaces the
      // old one, so the old tokens are revoked once it succeeds.
      const previous = await io.store.get(target.url)
      await browserLogin(target, io.store, {
        browser: command.browser,
        log,
      })
      if (previous.tokens) {
        const revocation = await revokeTokens(target, previous)
        if (!revocation.revoked)
          log(
            `Could not revoke the previous sign-in to ${target.title}: ${revocation.error}`,
          )
      }
      log(`Signed in to ${target.title}.`)
      return status(target, io)
    }
    case "logout":
      return logout(command.target, io)
    case "status":
      return status(command.target, io)
    case "instructions": {
      const text = await withClient(
        command.target,
        command.session,
        io,
        async (client) => client.getInstructions(),
      )
      if (!text) log("The server sent no instructions.")
      else
        io.stdout(
          `${command.app ? instructionsFor(text, command.app) : text}\n`,
        )
      return exitCodes.ok
    }
    case "tools": {
      const { app } = command
      const tools = (
        await withClient(command.target, command.session, io, listTools)
      ).filter((tool) => !app || tool.name.startsWith(`${app.name}_`))
      if (!command.name) {
        io.stdout(
          json(
            tools.map((tool) => ({
              name: tool.name,
              title: tool.title ?? tool.annotations?.title,
              description: tool.description?.split("\n")[0],
            })),
          ),
        )
        return exitCodes.ok
      }
      const name = app ? toolName(app, command.name) : command.name
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool)
        throw new CliError(
          "NOT_FOUND",
          `You have no tool named ${name}. Run fulldev ${app ? `${app.name} ` : ""}tools for the list.`,
        )
      io.stdout(
        json({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        }),
      )
      return exitCodes.ok
    }
    case "call": {
      const args = await readToolArguments({
        json: command.json,
        file: command.file,
      })
      if (command.allOrganizations) return callInEvery(command, args, io)
      if (command.organization !== undefined)
        args.organization = command.organization
      const result = await withClient(
        command.target,
        command.session,
        io,
        (client) =>
          client.callTool(
            { name: command.tool, arguments: args },
            { timeout: requestTimeoutMs },
          ),
      )
      if (result.isError) {
        io.stderr(json(toolError(result)))
        return exitCodes.error
      }
      io.stdout(json(toolOutput(result)))
      return exitCodes.ok
    }
    case "form-wait": {
      const outcome = await withClient(
        command.target,
        command.session,
        io,
        (client) =>
          waitForForm(
            (name, args, signal) =>
              client.callTool(
                {
                  name,
                  arguments:
                    command.organization === undefined
                      ? args
                      : { ...args, organization: command.organization },
                },
                { timeout: requestTimeoutMs, signal },
              ),
            {
              branchId: command.branchId,
              formId: command.formId,
              timeoutMs: command.timeoutMinutes * 60_000,
              app: command.app.name,
              progress: log,
            },
          ),
      )
      if (outcome.status === "error") {
        io.stderr(json(outcome.error))
        return exitCodes.error
      }
      io.stdout(json(outcome.result))
      return outcome.status === "timeout" ? exitCodes.timeout : exitCodes.ok
    }
  }
}

/** Runs the CLI and returns the exit code; every error becomes one JSON object on stderr. */
export async function main(argv: Array<string>, io: Io): Promise<number> {
  try {
    return await run(parseCommandLine(argv, io.env), io)
  } catch (error) {
    const { body, exitCode } = describeError(error)
    io.stderr(json(body))
    return exitCode
  }
}
