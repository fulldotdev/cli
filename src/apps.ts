import { UsageError } from "./errors.ts"

/** The Fulldev MCP server: the tools of every app the person may use. */
export const server = {
  title: "Fulldev",
  url: "https://app.full.dev/mcp",
}

/** The environment variable that overrides the server's URL. */
export const urlVariable = "FULLDEV_URL"

/**
 * A Fulldev app on the server. Its tools start with its name, such as
 * `cms_list_repositories`. Add an app with one entry.
 */
export interface App {
  name: string
  title: string
  description: string
  /** Has the cms_wait_for_form tool, so `fulldev <app> form wait` exists. */
  forms?: boolean
}

export const apps: Array<App> = [
  {
    name: "cms",
    title: "Fulldev CMS",
    description:
      "Edit your website: text, pages, images and settings, through a pull request.",
    forms: true,
  },
  {
    name: "connect",
    title: "Fulldev Connect",
    description:
      "Use your organization's business tools, such as Shopify, with the access Fulldev grants you.",
  },
  {
    name: "scan",
    title: "Fulldev Scan",
    description: "Scan whole websites for problems. For administrators only.",
  },
  {
    name: "sites",
    title: "Fulldev Sites",
    description:
      "Have Fulldev make a finished website from a brief and tested design options. For administrators only for now.",
  },
  {
    name: "pages",
    title: "Fulldev Pages",
    description:
      "Publish reports and plans as clear web pages, composed from ready-made blocks. For administrators only for now.",
  },
  {
    name: "contacts",
    title: "Fulldev Contacts",
    description:
      "Look after the daily copy of your Google contacts from one Google account to another: its runs, look-alike questions, pausing and resuming.",
  },
]

/** The server this run uses. */
export interface Target {
  title: string
  url: string
  /** True when --url chose the server, so commands must repeat it. */
  urlFromFlag: boolean
}

export function findApp(name: string): App | undefined {
  return apps.find((app) => app.name === name)
}

/**
 * A tool's name on the server: an app's tools start with the app's name,
 * which may be left out after `fulldev <app>`.
 */
export function toolName(app: App, name: string) {
  return name.startsWith(`${app.name}_`) ? name : `${app.name}_${name}`
}

/** The server: --url, then FULLDEV_URL, then app.full.dev. */
export function resolveTarget(
  flagUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): Target {
  const url = flagUrl ?? env[urlVariable] ?? server.url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`Not a valid server URL: ${url}`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new UsageError(`The server URL must use https: ${url}`)
  return {
    title: server.title,
    url: parsed.href,
    urlFromFlag: flagUrl !== undefined,
  }
}
