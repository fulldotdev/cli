import { parseArgs } from "node:util"

export const defaultUrl = "https://cms.full.dev/mcp"

/** A mistake in how the CLI was called. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export interface CommandLine {
  command: string | undefined
  args: Array<string>
  url: string
  file: string | undefined
  timeoutMinutes: number
  login: boolean
  browser: boolean
  help: boolean
  version: boolean
}

const expected: Record<string, [min: number, max: number, usage: string]> = {
  login: [0, 0, "fulldev login"],
  logout: [0, 0, "fulldev logout"],
  status: [0, 0, "fulldev status"],
  instructions: [0, 0, "fulldev instructions"],
  tools: [0, 1, "fulldev tools [name]"],
  call: [1, 2, "fulldev call <tool> [json | -] [--file <path>]"],
  form: [3, 3, "fulldev form wait <branchId> <formId> [--timeout <minutes>]"],
  help: [0, 0, "fulldev help"],
}

export function parseCommandLine(
  argv: Array<string>,
  env: NodeJS.ProcessEnv = process.env,
): CommandLine {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        url: { type: "string" },
        file: { type: "string", short: "f" },
        timeout: { type: "string" },
        login: { type: "boolean", default: true },
        browser: { type: "boolean", default: true },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
  const { values, positionals } = parsed
  const [command, ...args] = positionals

  const url = values.url ?? env.FULLDEV_URL ?? defaultUrl
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new UsageError(`Not a valid server URL: ${url}`)
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
    throw new UsageError(`The server URL must use https: ${url}`)

  const timeoutMinutes =
    values.timeout === undefined ? 30 : Number(values.timeout)
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)
    throw new UsageError(`--timeout must be a number of minutes above 0.`)

  const result: CommandLine = {
    command,
    args,
    url: parsedUrl.href,
    file: values.file,
    timeoutMinutes,
    login: values.login,
    browser: values.browser,
    help: values.help,
    version: values.version,
  }
  if (!command || result.help || result.version) return result

  const rule = expected[command]
  if (!rule) throw new UsageError(`Unknown command: ${command}`)
  const [min, max, usage] = rule
  if (command === "form" && args[0] !== "wait")
    throw new UsageError(`Usage: ${usage}`)
  if (args.length < min || args.length > max)
    throw new UsageError(`Usage: ${usage}`)
  if (values.file !== undefined && command !== "call")
    throw new UsageError("--file only works with fulldev call.")
  if (values.timeout !== undefined && command !== "form")
    throw new UsageError("--timeout only works with fulldev form wait.")
  return result
}

export const help = `Fulldev CLI: edit your website through the Fulldev CMS.

Usage:
  fulldev login                     Sign in (opens your browser)
  fulldev logout                    Forget the saved sign-in for this server
  fulldev status                    Show who is signed in and whether it works
  fulldev instructions              Print the server's instructions for agents
  fulldev tools [name]              List tools, or show one tool's input schema
  fulldev call <tool> [json | -]    Call a tool with a JSON object (- reads stdin)
  fulldev form wait <branchId> <formId>
                                    Wait until the person sends a form

Options:
  --url <mcp url>      Server to use (default ${defaultUrl}, or FULLDEV_URL)
  -f, --file <path>    Read the tool's JSON input from a file (call)
  --timeout <minutes>  How long form wait waits (default 30)
  --no-login           Fail instead of opening a sign-in when not signed in
  --no-browser         Print the sign-in link without opening a browser
  -h, --help           Show this help
  -v, --version        Show the version

Results are JSON on stdout; hints and errors go to stderr.
Exit codes: 0 done, 1 error, 2 form wait timed out, 3 sign-in needed.
`
