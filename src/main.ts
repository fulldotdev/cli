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
  describeError,
  exitCodes,
  isSignInRequired,
} from "./errors.ts"
import { waitForForm } from "./form-wait.ts"
import { readToolArguments } from "./input.ts"
import {
  StoredTokenAuth,
  browserLogin,
  claims,
  deviceLogin,
  expiresAt,
  revokeTokens,
} from "./oauth.ts"
import { products } from "./products.ts"
import type { Target } from "./products.ts"
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

async function productStatus(target: Target, io: Io) {
  const { credentials, storage } = await io.store.read(target.url)
  const base = { product: target.name, server: target.url }
  if (!credentials.tokens) return { ...base, signedIn: false }
  // valid: the server accepts the sign-in; unknown (with error) when it could not be checked.
  let valid: boolean | undefined = true
  let error: string | undefined
  try {
    const client = await connect(target, io)
    await client.close().catch(() => {})
  } catch (cause) {
    if (isSignInRequired(cause)) valid = false
    else {
      valid = undefined
      error = (cause as Error).message
    }
  }
  const current = await io.store.get(target.url)
  const access = claims(current.tokens?.access_token)
  const expires = expiresAt(current)
  return {
    ...base,
    signedIn: Boolean(current.tokens),
    valid,
    ...(error ? { error } : {}),
    email: current.email,
    organizationId: access.org_id,
    expiresAt: expires ? new Date(expires).toISOString() : undefined,
    storage,
  }
}

async function status(targets: Array<Target>, io: Io) {
  const results = []
  for (const target of targets) results.push(await productStatus(target, io))
  const storage = await io.store.storage()
  io.stdout(
    json({
      storage:
        storage === "keychain"
          ? { kind: "keychain", service: "fulldev" }
          : {
              kind: "file",
              path: io.store.filePath,
              reason: `The OS keychain is unavailable: ${io.store.keychainError}`,
            },
      products: results,
    }),
  )
  // Sign-in is needed when no listed product can be used; a product the
  // person does not use does not make status fail.
  if (
    !results.some(
      (result) =>
        result.signedIn && !("valid" in result && result.valid === false),
    )
  )
    return exitCodes.signIn
  return results.some((result) => "error" in result)
    ? exitCodes.error
    : exitCodes.ok
}

async function logout(targets: Array<Target>, io: Io) {
  const results = []
  for (const target of targets) {
    const credentials = await io.store.get(target.url)
    if (!credentials.tokens && !credentials.client) {
      results.push({ product: target.name, signedIn: false })
      continue
    }
    const revocation = await revokeTokens(target, credentials)
    if (!revocation.revoked)
      io.stderr(
        `Could not revoke the tokens of ${target.title}: ${revocation.error} They are deleted from this computer anyway.\n`,
      )
    await io.store.update(target.url, () => ({}))
    results.push({
      product: target.name,
      signedIn: false,
      revoked: revocation.revoked,
      ...(revocation.error ? { revocationError: revocation.error } : {}),
    })
  }
  io.stdout(json({ products: results }))
  return exitCodes.ok
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

  for (const { url, credentials } of await io.store.migrate()) {
    const product = products.find((candidate) => candidate.url === url)
    const name = product?.name
    // Best effort: the old tokens stop working at Clerk too.
    if (product)
      await revokeTokens({ ...product, urlFromFlag: false }, credentials)
    log(
      `fulldev now signs in per product and keeps tokens in the OS keychain. The sign-in from fulldev 0.1.0 for ${url} was removed; run fulldev login${name ? ` ${name}` : ""} to sign in again.`,
    )
  }

  switch (command.kind) {
    case "login":
      for (const target of command.targets) {
        // A new sign-in, such as one to switch organization, replaces the
        // old one, so the old tokens are revoked once it succeeds.
        const previous = await io.store.get(target.url)
        if (command.device) await deviceLogin(target, io.store, { log })
        else
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
      }
      return status(command.targets, io)
    case "logout":
      return logout(command.targets, io)
    case "status":
      return status(command.targets, io)
    case "instructions": {
      const text = await withClient(
        command.target,
        command.session,
        io,
        async (client) => client.getInstructions(),
      )
      if (!text) log("The server sent no instructions.")
      else io.stdout(`${text}\n`)
      return exitCodes.ok
    }
    case "tools": {
      const tools = await withClient(
        command.target,
        command.session,
        io,
        listTools,
      )
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
      const tool = tools.find((candidate) => candidate.name === command.name)
      if (!tool)
        throw new CliError(
          "NOT_FOUND",
          `${command.target.title} has no tool named ${command.name}. Run fulldev ${command.target.name} tools for the list.`,
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
                { name, arguments: args },
                { timeout: requestTimeoutMs, signal },
              ),
            {
              branchId: command.branchId,
              formId: command.formId,
              timeoutMs: command.timeoutMinutes * 60_000,
              product: command.target.name,
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
