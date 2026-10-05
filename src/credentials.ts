import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type {
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"

/** What the CLI keeps for one MCP server. */
export interface ServerCredentials {
  /** The client registered with the authorization server. */
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  /** When the tokens were saved, in milliseconds, to compute their expiry. */
  savedAt?: number
}

interface CredentialsFile {
  servers: Record<string, ServerCredentials>
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "fulldev", "credentials.json")
}

async function readAll(path: string): Promise<CredentialsFile> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"))
    if (
      data &&
      typeof data === "object" &&
      "servers" in data &&
      data.servers &&
      typeof data.servers === "object"
    )
      return data as CredentialsFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return { servers: {} }
}

/** Writes the whole file readable only by this user, replacing it atomically. */
async function writeAll(path: string, data: CredentialsFile) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/** Reads and writes the credentials of one server, keyed by its MCP URL. */
export class CredentialStore {
  constructor(
    readonly serverUrl: string,
    readonly path = credentialsPath(),
  ) {}

  async get(): Promise<ServerCredentials> {
    return (await readAll(this.path)).servers[this.serverUrl] ?? {}
  }

  async update(change: (current: ServerCredentials) => ServerCredentials) {
    const data = await readAll(this.path)
    const next = change(data.servers[this.serverUrl] ?? {})
    if (Object.keys(next).length) data.servers[this.serverUrl] = next
    else delete data.servers[this.serverUrl]
    if (Object.keys(data.servers).length) await writeAll(this.path, data)
    else await rm(this.path, { force: true })
  }
}
