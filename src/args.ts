import { parseArgs } from "node:util"

import { UsageError } from "./errors.ts"
import {
  apps,
  findApp,
  resolveTarget,
  server,
  toolName,
  urlVariable,
} from "./apps.ts"
import type { App, Target } from "./apps.ts"

export type Command =
  | { kind: "help"; topic: string }
  | { kind: "version" }
  | { kind: "login"; target: Target; browser: boolean }
  | { kind: "logout"; target: Target }
  | { kind: "status"; target: Target }
  /** With an app: the overview and that app's own instructions. */
  | { kind: "instructions"; target: Target; session: Session; app?: App }
  /** With an app: only its tools; `name` may leave out its prefix. */
  | {
      kind: "tools"
      target: Target
      session: Session
      app?: App
      name?: string
    }
  | {
      kind: "call"
      target: Target
      session: Session
      /** The tool's full name on the server. */
      tool: string
      json?: string
      file?: string
      /** The organization to work in, by slug or id. */
      organization?: string
      /** Every organization of the sign-in that has the tool's app. */
      allOrganizations?: boolean
    }
  | {
      kind: "form-wait"
      target: Target
      session: Session
      app: App
      branchId: string
      formId: string
      timeoutMinutes: number
      organization?: string
    }

/** How a command may sign in when it needs to. */
export interface Session {
  login: boolean
  browser: boolean
}

type Option =
  | "url"
  | "file"
  | "timeout"
  | "login"
  | "browser"
  | "org"
  | "all-orgs"

interface Topic {
  usage: string
  summary: string
  options?: Array<Option>
  details?: string
}

const organizationDetails = `
When the sign-in is for more than one organization, --org names the one to
work in, by its slug from fulldev status. --all-orgs calls a tool that only
reads in every organization of the sign-in that has its app, and prints
{"organizations":[{"organization","result" or "error"}]}; it exits with 1
when one failed.`

const rootCommands: Record<string, Topic> = {
  login: {
    usage: "fulldev login [--no-browser] [--url <mcp url>]",
    summary: "Sign in, once for every app and organization",
    options: ["browser", "url"],
    details: `Signs in to the Fulldev MCP server in your browser, where you choose the
organizations fulldev may work in: all of yours at first. One sign-in covers
every app they give you. Run fulldev login again to change the choice, and
choose the organization of a call with --org.

With --no-browser, open the link in a browser on any computer. When that is
another computer, as over SSH, the page after sign-in does not load: copy its
address from the address bar and paste it into this terminal.`,
  },
  logout: {
    usage: "fulldev logout [--url <mcp url>]",
    summary: "Sign out and revoke the tokens",
    options: ["url"],
    details: `Revokes the refresh token at the authorization server and deletes the
tokens from this computer. The access token cannot be revoked and expires
within 15 minutes. When revoking fails, the local sign-out still happens and
the result says so.`,
  },
  status: {
    usage: "fulldev status [--url <mcp url>]",
    summary: "Show the sign-in",
    options: ["url"],
    details: `Prints whether you are signed in, whether the sign-in still works, your
email, the organizations of the sign-in with their slugs and the apps you may
use in each, when the access token expires, and where the tokens are stored. Exits with 3 when a sign-in is needed, and with 1 when the
server could not be reached to check it.`,
  },
  instructions: {
    usage: "fulldev instructions",
    summary:
      "The instructions for agents, of every app you may use; read first",
    options: ["url", "login", "browser"],
    details: `Prints the instructions the server sends, as plain text: an overview, then
each app's own, under its name. fulldev <app> instructions prints the
overview and that app's part.`,
  },
  tools: {
    usage: "fulldev tools [name]",
    summary: "List the tools of every app you may use, or show one tool",
    options: ["url", "login", "browser"],
    details: `Without a name: the name, title and first line of the description of each
tool. With a name: its description, input schema, output schema and
annotations. Each app's tools start with its name, such as cms_.`,
  },
  call: {
    usage: "fulldev call <tool> [json | -] [--file <path>] [--org <slug>]",
    summary: "Call a tool with a JSON object",
    options: ["file", "org", "all-orgs", "url", "login", "browser"],
    details: `The tool's input is a JSON object: the argument, a file with --file, or
stdin with -. Without input it sends {}. Prints the tool's result as JSON on
stdout. When the tool fails, prints its error on stderr and exits with 1.
${organizationDetails}`,
  },
  help: {
    usage: "fulldev help [command...]",
    summary: "Show help for a command",
  },
}

/** The commands that use the server, also per app. */
const serverCommands = ["instructions", "tools", "call"] as const

const appCommands: Record<string, Topic> = {
  instructions: {
    usage: "fulldev <app> instructions",
    summary: "The overview and the app's own instructions; read first",
    options: ["url", "login", "browser"],
    details: "Prints them as plain text, as the server sends them.",
  },
  tools: {
    usage: "fulldev <app> tools [name]",
    summary: "List the app's tools, or show one tool",
    options: ["url", "login", "browser"],
    details: `Without a name: the name, title and first line of the description of each
of the app's tools. With a name, with or without the app's prefix: its
description, input schema, output schema and annotations.`,
  },
  call: {
    usage:
      "fulldev <app> call <tool> [json | -] [--file <path>] [--org <slug>]",
    summary: "Call one of the app's tools with a JSON object",
    options: ["file", "org", "all-orgs", "url", "login", "browser"],
    details: `The tool's name may leave out the app's prefix: fulldev cms call
list_repositories calls cms_list_repositories. Its input is a JSON object:
the argument, a file with --file, or stdin with -. Without input it sends
{}. Prints the tool's result as JSON on stdout. When the tool fails, prints
its error on stderr and exits with 1.
${organizationDetails}`,
  },
}

const formWait: Topic = {
  usage:
    "fulldev <app> form wait <branchId> <formId> [--timeout <minutes>] [--org <slug>]",
  summary: "Wait until the person sends a form",
  options: ["timeout", "org", "url", "login", "browser"],
  details: `Calls cms_wait_for_form until the person sends the form, with a progress
line on stderr each round, then prints the result. After --timeout minutes
(default 30) it prints the form id and exits with 2, so you can run it again.`,
}

const optionHelp: Record<Option, string> = {
  url: "--url <mcp url>      Use another server, such as a deploy preview's",
  file: "-f, --file <path>    Read the tool's JSON input from a file",
  timeout: "--timeout <minutes>  How long to wait (default 30)",
  login: "--no-login           Fail with exit code 3 instead of signing in",
  browser:
    "--no-browser         Print the sign-in link, for a browser here or elsewhere",
  org: "--org <slug>         The organization to work in",
  "all-orgs":
    "--all-orgs           Every organization of the sign-in (reading tools)",
}

const footer = `Data is JSON on stdout; progress lines go to stderr. Every error is one JSON
object on stderr: {"error":{"code","message",...}}.
Exit codes: 0 ok, 1 error, 2 form wait timed out, 3 sign-in needed, 64 usage error.
`

const pad = (text: string, width: number) => text.padEnd(width)

function appTopics(app: App): Record<string, Topic> {
  const name = (topic: Topic): Topic => ({
    ...topic,
    usage: topic.usage.replace("<app>", app.name),
  })
  const topics: Record<string, Topic> = {}
  for (const [command, topic] of Object.entries(appCommands))
    topics[`${app.name} ${command}`] = name(topic)
  if (app.forms) {
    const wait = name(formWait)
    topics[`${app.name} form`] = wait
    topics[`${app.name} form wait`] = wait
  }
  return topics
}

const serverLine = `Server: ${server.url} (${urlVariable} or --url overrides it)`

function rootHelp() {
  const width = Math.max(...apps.map((app) => app.name.length)) + 4
  return `Fulldev CLI: use Fulldev apps from a terminal or an AI agent, through the
Fulldev MCP server. One sign-in covers every app of the organizations you
choose; --org picks one per call.

Usage:
  fulldev <command> [options]
  fulldev <app> <command> [options]

Commands:
${Object.values(rootCommands)
  .map((topic) => `  ${pad(topic.usage.split(" [--")[0]!, 32)}${topic.summary}`)
  .join("\n")}

Apps (their tools start with the app's name, such as cms_):
${apps.map((app) => `  ${pad(app.name, width)}${app.description}`).join("\n")}

App commands, for one app's part:
${[
  ...Object.values(appCommands),
  { ...formWait, usage: formWait.usage.replace("<app>", "cms") },
]
  .map((topic) => `  ${topic.usage.split(" [--")[0]}\n      ${topic.summary}`)
  .join("\n")}

Run fulldev instructions first and follow them.
Run fulldev help <command...> for a command's options, for example
fulldev help cms call.

${serverLine}

Options:
  -h, --help     Show help
  -v, --version  Show the version

${footer}`
}

function appHelp(app: App) {
  const topics = Object.values(appTopics(app)).filter(
    (topic, index, all) => all.indexOf(topic) === index,
  )
  return `${app.title}

${app.description}

Its tools start with ${app.name}_; after fulldev ${app.name} you may leave that out.

Usage:
${topics.map((topic) => `  ${topic.usage}\n      ${topic.summary}`).join("\n")}

Run fulldev ${app.name} instructions first and follow them.
Sign in with fulldev login, once for every app.

${serverLine}

${footer}`
}

function topicHelp(topic: Topic) {
  const options = topic.options?.map((option) => `  ${optionHelp[option]}`)
  return `Usage: ${topic.usage}

${topic.summary}.
${topic.details ? `\n${topic.details}\n` : ""}${options?.length ? `\nOptions:\n${options.join("\n")}\n` : ""}
${footer}`
}

/** The help text for a topic such as "", "login", "cms" or "cms call". */
export function helpText(topic: string): string | undefined {
  if (topic === "") return rootHelp()
  const root = rootCommands[topic]
  if (root) return topicHelp(root)
  const app = findApp(topic)
  if (app) return appHelp(app)
  const [name] = topic.split(" ")
  const owner = findApp(name ?? "")
  const found = owner ? appTopics(owner)[topic] : undefined
  return found ? topicHelp(found) : undefined
}

/** The longest leading words of `words` that name a help topic. */
function closestTopic(words: Array<string>) {
  for (let length = Math.min(words.length, 3); length > 0; length--) {
    const topic = words.slice(0, length).join(" ")
    if (helpText(topic) !== undefined) return topic
  }
  return ""
}

const helpFor = (topic: string) =>
  topic ? `fulldev ${topic} --help` : "fulldev --help"

export function parseCommandLine(
  argv: Array<string>,
  env: NodeJS.ProcessEnv = process.env,
): Command {
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
        org: { type: "string" },
        "all-orgs": { type: "boolean" },
        timeout: { type: "string" },
        login: { type: "boolean" },
        browser: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    })
  } catch (error) {
    throw new UsageError(
      (error as Error).message,
      helpFor(closestTopic(argv.filter((word) => !word.startsWith("-")))),
    )
  }
  const { values, positionals } = parsed

  if (values.version) return { kind: "version" }
  if (positionals[0] === "help") {
    const topic = positionals.slice(1).join(" ")
    if (helpText(topic) === undefined)
      throw new UsageError(`No help for: ${topic}`)
    return { kind: "help", topic }
  }
  if (values.help) return { kind: "help", topic: closestTopic(positionals) }
  if (positionals.length === 0) return { kind: "help", topic: "" }

  const [first, ...rest] = positionals as [string, ...Array<string>]
  const given = (Object.keys(values) as Array<keyof typeof values>).filter(
    (key) => values[key] !== undefined,
  )
  const allow = (topic: string, options: Array<Option> = []) => {
    const extra = given.find((key) => !options.includes(key as Option))
    if (extra)
      throw new UsageError(
        `--${extra === "login" || extra === "browser" ? `no-${extra}` : extra} does not work with fulldev ${topic}.`,
        helpFor(topic),
      )
  }

  const target = resolveTarget(values.url, env)
  const session: Session = {
    login: values.login ?? true,
    browser: values.browser ?? true,
  }

  if (first === "login" || first === "logout" || first === "status") {
    allow(first, rootCommands[first]!.options)
    if (rest.length) {
      // Sign-ins were per app until 0.4, so `fulldev login cms` is a habit.
      const app = findApp(rest[0]!)
      const command = `fulldev ${first}${target.urlFromFlag ? ` --url ${target.url}` : ""}`
      throw new UsageError(
        app
          ? `One sign-in covers every app, ${app.title} too. Run: ${command}`
          : `fulldev ${first} takes no app: one sign-in covers every app. Run: ${command}`,
        helpFor(first),
        { command },
      )
    }
    if (first === "login")
      return { kind: "login", target, browser: values.browser ?? true }
    return { kind: first, target }
  }

  const app = findApp(first)
  const command = app ? rest[0] : first
  const args = app ? rest.slice(1) : rest
  if (!app && !(serverCommands as ReadonlyArray<string>).includes(first))
    throw new UsageError(`Unknown command or app: ${first}`)
  if (app && command === undefined) {
    allow(app.name)
    return { kind: "help", topic: app.name }
  }
  const topic = app ? `${app.name} ${command}` : first
  const known = app ? appTopics(app)[topic] : rootCommands[topic]
  if (!known)
    throw new UsageError(
      `Unknown command: fulldev ${topic}`,
      helpFor(app?.name ?? ""),
    )
  allow(topic, known.options)
  const usage = (count: boolean) => {
    if (!count) throw new UsageError(`Usage: ${known.usage}`, helpFor(topic))
  }

  switch (command) {
    case "instructions":
      usage(args.length === 0)
      return { kind: "instructions", target, session, app }
    case "tools":
      usage(args.length <= 1)
      return { kind: "tools", target, session, app, name: args[0] }
    case "call":
      usage(args.length === 1 || args.length === 2)
      if (values.org !== undefined && values["all-orgs"])
        throw new UsageError(
          "Use --org or --all-orgs, not both.",
          helpFor(topic),
        )
      return {
        kind: "call",
        target,
        session,
        tool: app ? toolName(app, args[0]!) : args[0]!,
        json: args[1],
        file: values.file,
        organization: values.org,
        allOrganizations: values["all-orgs"],
      }
    default: {
      usage(app !== undefined && args[0] === "wait" && args.length === 3)
      const timeoutMinutes =
        values.timeout === undefined ? 30 : Number(values.timeout)
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)
        throw new UsageError(
          "--timeout must be a number of minutes above 0.",
          helpFor(topic),
        )
      return {
        kind: "form-wait",
        target,
        session,
        app: app!,
        branchId: args[1]!,
        formId: args[2]!,
        timeoutMinutes,
        organization: values.org,
      }
    }
  }
}
