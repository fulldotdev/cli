import { OAuthError, ProtocolError } from "@modelcontextprotocol/client"

import type { Target } from "./apps.ts"

export const exitCodes = {
  ok: 0,
  error: 1,
  timeout: 2,
  signIn: 3,
  usage: 64,
} as const

/** An error the CLI reports as {"error":{"code","message",...}} with an exit code. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = exitCodes.error,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "CliError"
  }
}

/** A mistake in how the CLI was called. */
export class UsageError extends CliError {
  constructor(message: string, help = "fulldev --help") {
    super("USAGE", message, exitCodes.usage, { help })
    this.name = "UsageError"
  }
}

/** A command needs a sign-in that it may not start itself. */
export class SignInRequiredError extends CliError {
  constructor(readonly target: Target) {
    const command = `fulldev login${target.urlFromFlag ? ` --url ${target.url}` : ""}`
    super(
      "SIGN_IN_REQUIRED",
      `Not signed in to ${target.title}. Run: ${command}`,
      exitCodes.signIn,
      { server: target.url, command },
    )
    this.name = "SignInRequiredError"
  }
}

export function isSignInRequired(error: unknown): error is SignInRequiredError {
  return findCause(error, SignInRequiredError) !== undefined
}

/** The first error in the cause chain that is an instance of `type`. */
function findCause<T extends Error>(
  error: unknown,
  type: abstract new (...args: Array<never>) => T,
): T | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof type) return cause
  return undefined
}

/** Any error as the one JSON object the CLI prints on stderr, with its exit code. */
export function describeError(error: unknown): {
  body: { error: Record<string, unknown> }
  exitCode: number
} {
  const cli = findCause(error, CliError)
  if (cli)
    return {
      body: { error: { code: cli.code, message: cli.message, ...cli.details } },
      exitCode: cli.exitCode,
    }
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof OAuthError)
    return {
      body: {
        error: { code: "OAUTH_ERROR", message, oauthError: error.code },
      },
      exitCode: exitCodes.error,
    }
  if (error instanceof ProtocolError)
    return {
      body: {
        error: { code: "PROTOCOL_ERROR", message, protocolCode: error.code },
      },
      exitCode: exitCodes.error,
    }
  if (error instanceof TypeError && /fetch failed/i.test(message))
    return {
      body: {
        error: {
          code: "NETWORK_ERROR",
          message: `${message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`,
        },
      },
      exitCode: exitCodes.error,
    }
  return {
    body: { error: { code: "ERROR", message } },
    exitCode: exitCodes.error,
  }
}
