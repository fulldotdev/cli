import { AsyncLocalStorage } from "node:async_hooks"
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type {
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"

import { CliError } from "./errors.ts"

/** What the CLI keeps for one product server, keyed by its MCP URL. */
export interface Credentials {
  /** The authorization server that issued the tokens. */
  issuer?: string
  /** A dynamically registered client, only for an issuer without a Fulldev client id. */
  client?: StoredOAuthClientInformation
  /** The tokens, without the ID token, which is only read for the email. */
  tokens?: StoredOAuthTokens
  email?: string
  /** When the tokens were saved, in milliseconds, to compute their expiry. */
  savedAt?: number
}

/** A stored record: the credentials and when they were written. */
type Stored = Credentials & { writtenAt?: number }

function withoutStamp({ writtenAt: _, ...credentials }: Stored): Credentials {
  return credentials
}

export type Storage = "keychain" | "file"

/** The OS keychain: one secret per account, under one service. */
export interface Keychain {
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

export const keychainService = "fulldev"

/** The OS keychain through @napi-rs/keyring; rejects when it cannot load. */
export async function openKeychain(): Promise<Keychain> {
  const { AsyncEntry } = await import("@napi-rs/keyring")
  const entry = (account: string) => new AsyncEntry(keychainService, account)
  return {
    get: async (account) => (await entry(account).getPassword()) ?? undefined,
    set: (account, secret) => entry(account).setPassword(secret),
    delete: async (account) => {
      await entry(account).deleteCredential()
    },
  }
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fulldev")
}

const held = new AsyncLocalStorage<true>()

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Runs `action` while holding a lock file, so parallel fulldev processes take
 * turns updating credentials, for example when two refresh the same token.
 * Nested calls in the same action reuse the lock. A lock left by a process
 * that ended, or older than `staleMs`, is taken over.
 */
export async function withLock<T>(
  path: string,
  action: () => Promise<T>,
  { timeoutMs = 60_000, staleMs = 120_000 } = {},
): Promise<T> {
  if (held.getStore()) return action()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600)
      await handle.writeFile(String(process.pid))
      await handle.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const [owner, info] = await Promise.all([
      readFile(path, "utf8").catch(() => ""),
      stat(path).catch(() => undefined),
    ])
    const pid = Number(owner)
    const stale =
      (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) ||
      (info !== undefined && Date.now() - info.mtimeMs > staleMs)
    if (stale) {
      await rm(path, { force: true })
      continue
    }
    if (Date.now() > deadline)
      throw new Error(
        `Another fulldev process holds ${path}. Try again, or delete the file if no fulldev command is running.`,
      )
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50))
  }
  try {
    return await held.run(true, action)
  } finally {
    await rm(path, { force: true })
  }
}

interface CredentialsFile {
  version: 2
  servers: Record<string, Credentials>
}

const isEmpty = (credentials: Credentials) =>
  Object.keys(credentials).length === 0

/**
 * Keeps credentials per product server in the OS keychain (service "fulldev",
 * account = the MCP URL). When the keychain is unavailable or rejects a write,
 * it uses a JSON file readable only by this user instead.
 */
export class CredentialStore {
  readonly filePath: string
  readonly lockPath: string
  /** The 0.1.0 file, removed once by migrate(). */
  readonly legacyPath: string
  /** Why the keychain is not used, once it failed. */
  keychainError: string | undefined
  private keychain: Promise<Keychain | undefined> | undefined

  constructor(
    readonly directory = configDirectory(),
    private readonly loadKeychain: () => Promise<Keychain> = openKeychain,
  ) {
    this.filePath = join(directory, "auth.json")
    this.lockPath = join(directory, "auth.lock")
    this.legacyPath = join(directory, "credentials.json")
  }

  /** Where new credentials go. */
  async storage(): Promise<Storage> {
    return (await this.openKeychain()) ? "keychain" : "file"
  }

  private openKeychain() {
    this.keychain ??= this.loadKeychain().catch((error: unknown) => {
      this.keychainError = (error as Error).message
      return undefined
    })
    return this.keychain
  }

  private disableKeychain(error: unknown) {
    this.keychainError = (error as Error).message
    this.keychain = Promise.resolve(undefined)
  }

  locked<T>(action: () => Promise<T>) {
    return withLock(this.lockPath, action)
  }

  /** The server's credentials and where they were found. */
  async read(
    serverUrl: string,
  ): Promise<{ credentials: Credentials; storage?: Storage }> {
    let fromKeychain: Stored | undefined
    const keychain = await this.openKeychain()
    if (keychain) {
      try {
        const secret = await keychain.get(serverUrl)
        if (secret) fromKeychain = JSON.parse(secret) as Stored
      } catch (error) {
        this.disableKeychain(error)
      }
    }
    const fromFile = (await this.readFile()).servers[serverUrl] as
      | Stored
      | undefined
    // After a fallback both can exist; the one written last is current.
    if (
      fromKeychain &&
      (!fromFile || (fromKeychain.writtenAt ?? 0) >= (fromFile.writtenAt ?? 0))
    )
      return { credentials: withoutStamp(fromKeychain), storage: "keychain" }
    return fromFile
      ? { credentials: withoutStamp(fromFile), storage: "file" }
      : { credentials: {} }
  }

  async get(serverUrl: string) {
    return (await this.read(serverUrl)).credentials
  }

  /** Changes one server's credentials while holding the lock. */
  update(serverUrl: string, change: (current: Credentials) => Credentials) {
    return this.locked(async () => {
      const next = change(await this.get(serverUrl))
      if (isEmpty(next)) await this.delete(serverUrl)
      else await this.write(serverUrl, next)
    })
  }

  private async write(serverUrl: string, record: Credentials) {
    const credentials: Stored = { ...record, writtenAt: Date.now() }
    const keychain = await this.openKeychain()
    if (keychain) {
      try {
        await keychain.set(serverUrl, JSON.stringify(credentials))
        await this.changeFile((servers) => {
          delete servers[serverUrl]
        })
        return
      } catch (error) {
        this.disableKeychain(error)
        // An older keychain entry must not outlive this one; if it cannot be
        // removed, the newer file record still wins on read.
        await keychain.delete(serverUrl).catch(() => {})
      }
    }
    await this.changeFile((servers) => {
      servers[serverUrl] = credentials
    })
  }

  private async delete(serverUrl: string) {
    await this.changeFile((servers) => {
      delete servers[serverUrl]
    })
    const keychain = await this.openKeychain()
    if (!keychain) return
    try {
      await keychain.delete(serverUrl)
    } catch (error) {
      // A sign-out that leaves tokens in the keychain must not report success.
      const stillThere = await keychain.get(serverUrl).catch(() => undefined)
      if (stillThere)
        throw new CliError(
          "KEYCHAIN_ERROR",
          `The sign-in could not be removed from the OS keychain: ${(error as Error).message}. Remove the entry for ${serverUrl} under the service fulldev, or run this command in a terminal on this computer.`,
        )
      this.disableKeychain(error)
    }
  }

  private async readFile(): Promise<CredentialsFile> {
    try {
      const data = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<CredentialsFile>
      if (data.servers && typeof data.servers === "object")
        return { version: 2, servers: data.servers }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return { version: 2, servers: {} }
  }

  /** Rewrites the file readable only by this user, or deletes it when empty. */
  private async changeFile(
    change: (servers: Record<string, Credentials>) => void,
  ) {
    const data = await this.readFile()
    const before = JSON.stringify(data)
    change(data.servers)
    if (JSON.stringify(data) === before) return
    if (Object.keys(data.servers).length === 0) {
      await rm(this.filePath, { force: true })
      return
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    })
    await chmod(temporary, 0o600)
    await rename(temporary, this.filePath)
  }

  /**
   * Removes the credentials file of fulldev 0.1.0 once. Its tokens belong to
   * a dynamically registered client that the CLI no longer uses, so they are
   * dropped. Returns the servers that were signed in with their credentials,
   * so their tokens can be revoked and a new sign-in asked for.
   */
  async migrate(): Promise<Array<{ url: string; credentials: Credentials }>> {
    if (!(await stat(this.legacyPath).catch(() => undefined))) return []
    return this.locked(async () => {
      let data: unknown
      try {
        data = JSON.parse(await readFile(this.legacyPath, "utf8"))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return []
        if (!(error instanceof SyntaxError)) throw error
      }
      const servers =
        data && typeof data === "object" && "servers" in data
          ? (data.servers as Record<string, Credentials>)
          : {}
      await rm(this.legacyPath, { force: true })
      return Object.entries(servers)
        .filter(([, credentials]) => credentials.tokens)
        .map(([url, credentials]) => ({ url, credentials }))
    })
  }
}
