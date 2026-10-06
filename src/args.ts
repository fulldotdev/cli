import { parseArgs } from "node:util"

import { UsageError } from "./errors.ts"
import {
  findProduct,
  products,
  resolveTarget,
  urlVariable,
} from "./products.ts"
import type { Product, Target } from "./products.ts"

export type Command =
  | { kind: "help"; topic: string }
  | { kind: "version" }
  | { kind: "login"; targets: Array<Target>; device: boolean; browser: boolean }
  | { kind: "logout"; targets: Array<Target> }
  | { kind: "status"; targets: Array<Target> }
  | { kind: "instructions"; target: Target; session: Session }
  | { kind: "tools"; target: Target; session: Session; name?: string }
  | {
      kind: "call"
      target: Target
      session: Session
      tool: string
      json?: string
      file?: string
    }
  | {
      kind: "form-wait"
      target: Target
      session: Session
      branchId: string
      formId: string
      timeoutMinutes: number
    }

/** How a product command may sign in when it needs to. */
export interface Session {
  login: boolean
  browser: boolean
}

type Option = "url" | "file" | "timeout" | "device" | "login" | "browser"

interface Topic {
  usage: string
  summary: string
  options?: Array<Option>
  details?: string
}

const rootCommands: Record<string, Topic> = {
  login: {
    usage:
      "fulldev login [product...] [--device] [--no-browser] [--url <mcp url>]",
    summary: "Sign in (all products by default)",
    options: ["device", "browser", "url"],
    details: `Signs in to each product in turn in your browser, where you choose your
organization. Each product gets its own tokens; the browser session is shared,
so after the first product the others are quick. Run fulldev login <product>
again to switch that product to another organization.

--device prints a link and a code instead, for a machine without a browser.`,
  },
  logout: {
    usage: "fulldev logout [product...] [--url <mcp url>]",
    summary: "Sign out and revoke the tokens (all products by default)",
    options: ["url"],
    details: `Revokes the product's refresh and access tokens at the authorization server
and deletes them from this computer. When revoking fails, the local sign-out
still happens and the result says so.`,
  },
  status: {
    usage: "fulldev status [product...] [--url <mcp url>]",
    summary: "Show the sign-in of each product",
    options: ["url"],
    details: `Prints, per product, whether you are signed in, whether the sign-in still
works, your email, organization and when the access token expires, and where
the tokens are stored. Exits with 3 when a listed product needs a sign-in,
and with 1 when a server could not be reached to check it.`,
  },
  help: {
    usage: "fulldev help [command...]",
    summary: "Show help for a command",
  },
}

const productCommands: Record<string, Topic> = {
  instructions: {
    usage: "fulldev <product> instructions",
    summary: "The product's instructions for agents; read them first",
    options: ["url", "login", "browser"],
    details: "Prints the instructions the server sends, as plain text.",
  },
  tools: {
    usage: "fulldev <product> tools [name]",
    summary: "List the tools, or show one tool",
    options: ["url", "login", "browser"],
    details: `Without a name: the name, title and first line of the description of each
tool. With a name: its description, input schema, output schema and
annotations.`,
  },
  call: {
    usage: "fulldev <product> call <tool> [json | -] [--file <path>]",
    summary: "Call a tool with a JSON object",
    options: ["file", "url", "login", "browser"],
    details: `The tool's input is a JSON object: the argument, a file with --file, or
stdin with -. Without input it sends {}. Prints the tool's result as JSON on
stdout. When the tool fails, prints its error on stderr and exits with 1.`,
  },
}

const formWait: Topic = {
  usage:
    "fulldev <product> form wait <branchId> <formId> [--timeout <minutes>]",
  summary: "Wait until the person sends a form",
  options: ["timeout", "url", "login", "browser"],
  details: `Calls wait_for_form until the person sends the form, with a progress line on
stderr each round, then prints the result. After --timeout minutes (default
30) it prints the form id and exits with 2, so you can run it again.`,
}

const optionHelp: Record<Option, string> = {
  url: "--url <mcp url>      Use another server for the product, such as a deploy preview",
  file: "-f, --file <path>    Read the tool's JSON input from a file",
  timeout: "--timeout <minutes>  How long to wait (default 30)",
  device: "--device             Sign in with a code on another device",
  login: "--no-login           Fail with exit code 3 instead of signing in",
  browser:
    "--no-browser         Print the sign-in link without opening a browser",
}

const footer = `Data is JSON on stdout; progress lines go to stderr. Every error is one JSON
object on stderr: {"error":{"code","message",...}}.
Exit codes: 0 ok, 1 error, 2 form wait timed out, 3 sign-in needed, 64 usage error.
`

const pad = (text: string, width: number) => text.padEnd(width)

function productTopics(product: Product): Record<string, Topic> {
  const name = (topic: Topic): Topic => ({
    ...topic,
    usage: topic.usage.replace("<product>", product.name),
  })
  const topics: Record<string, Topic> = {}
  for (const [command, topic] of Object.entries(productCommands))
    topics[`${product.name} ${command}`] = name(topic)
  if (product.forms) {
    const wait = name(formWait)
    topics[`${product.name} form`] = wait
    topics[`${product.name} form wait`] = wait
  }
  return topics
}

function rootHelp() {
  const width = Math.max(...products.map((product) => product.name.length)) + 4
  return `Fulldev CLI: use Fulldev products from a terminal or an AI agent.

Usage:
  fulldev <product> <command> [options]
${Object.values(rootCommands)
  .map((topic) => `  ${pad(topic.usage.split(" [--")[0]!, 32)}${topic.summary}`)
  .join("\n")}

Products:
${products.map((product) => `  ${pad(product.name, width)}${product.description}`).join("\n")}

Product commands:
${[
  ...Object.values(productCommands),
  { ...formWait, usage: formWait.usage.replace("<product>", "cms") },
]
  .map((topic) => `  ${topic.usage.split(" [--")[0]}\n      ${topic.summary}`)
  .join("\n")}

Run fulldev <product> instructions first and follow them.
Run fulldev help <command...> for a command's options, for example
fulldev help cms call.

Options:
  -h, --help     Show help
  -v, --version  Show the version

${footer}`
}

function productHelp(product: Product) {
  const topics = Object.values(productTopics(product)).filter(
    (topic, index, all) => all.indexOf(topic) === index,
  )
  return `${product.title}

${product.description}

Server: ${product.url} (${urlVariable(product)} or --url overrides it)

Usage:
${topics.map((topic) => `  ${topic.usage}\n      ${topic.summary}`).join("\n")}

Run fulldev ${product.name} instructions first and follow them.
Sign in with fulldev login ${product.name}.

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
  const product = findProduct(topic)
  if (product) return productHelp(product)
  const [name] = topic.split(" ")
  const owner = findProduct(name ?? "")
  const found = owner ? productTopics(owner)[topic] : undefined
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
        timeout: { type: "string" },
        device: { type: "boolean" },
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

  if (first === "login" || first === "logout" || first === "status") {
    allow(first, rootCommands[first]!.options)
    const named = [...new Set(rest)].map((name) => {
      const product = findProduct(name)
      if (!product)
        throw new UsageError(`Unknown product: ${name}`, helpFor(first))
      return product
    })
    if (values.url !== undefined && named.length !== 1)
      throw new UsageError(
        `--url needs exactly one product, for example fulldev ${first} cms --url <mcp url>.`,
        helpFor(first),
      )
    const targets = (named.length ? named : products).map((product) =>
      resolveTarget(product, values.url, env),
    )
    if (first === "login")
      return {
        kind: "login",
        targets,
        device: values.device ?? false,
        browser: values.browser ?? true,
      }
    return { kind: first, targets }
  }

  const product = findProduct(first)
  if (!product) throw new UsageError(`Unknown command or product: ${first}`)
  const [command, ...args] = rest
  if (command === undefined) {
    allow(product.name)
    return { kind: "help", topic: product.name }
  }
  const topic = `${product.name} ${command}`
  const topics = productTopics(product)
  const known = topics[topic]
  if (!known)
    throw new UsageError(
      `Unknown command: fulldev ${topic}`,
      helpFor(product.name),
    )
  allow(topic, known.options)
  const usage = (count: boolean) => {
    if (!count) throw new UsageError(`Usage: ${known.usage}`, helpFor(topic))
  }
  const target = resolveTarget(product, values.url, env)
  const session: Session = {
    login: values.login ?? true,
    browser: values.browser ?? true,
  }

  switch (command) {
    case "instructions":
      usage(args.length === 0)
      return { kind: "instructions", target, session }
    case "tools":
      usage(args.length <= 1)
      return { kind: "tools", target, session, name: args[0] }
    case "call":
      usage(args.length === 1 || args.length === 2)
      return {
        kind: "call",
        target,
        session,
        tool: args[0]!,
        json: args[1],
        file: values.file,
      }
    default: {
      usage(args[0] === "wait" && args.length === 3)
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
        branchId: args[1]!,
        formId: args[2]!,
        timeoutMinutes,
      }
    }
  }
}
