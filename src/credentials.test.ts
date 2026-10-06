import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vite-plus/test"

import {
  CredentialStore,
  configDirectory,
  keychainService,
  withLock,
} from "./credentials.ts"
import type { Keychain } from "./credentials.ts"

const cms = "https://cms.full.dev/mcp"
const connect = "https://connect.full.dev/mcp"
const tokens = { access_token: "a", token_type: "Bearer", refresh_token: "r" }

/** An in-memory keychain; `failWrites` makes it reject writes like a full or locked store. */
function memoryKeychain({ failWrites = false } = {}) {
  const secrets = new Map<string, string>()
  const keychain: Keychain = {
    get: async (account) => secrets.get(account),
    set: async (account, secret) => {
      if (failWrites) throw new Error("The secret is too large")
      secrets.set(account, secret)
    },
    delete: async (account) => {
      secrets.delete(account)
    },
  }
  return { secrets, keychain }
}

const directory = () => mkdtemp(join(tmpdir(), "fulldev-"))

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

describe("CredentialStore", () => {
  it("prefers a newer file record over a stale keychain entry after a fallback", async () => {
    const secrets = new Map<string, string>()
    let failWrites = false
    const keychain: Keychain = {
      get: async (account) => secrets.get(account),
      set: async (account, secret) => {
        if (failWrites) throw new Error("User interaction is not allowed")
        secrets.set(account, secret)
      },
      // A keychain that also cannot delete, as over SSH.
      delete: async () => {
        if (failWrites) throw new Error("User interaction is not allowed")
      },
    }
    const dir = await directory()
    await new CredentialStore(dir, async () => keychain).update(cms, () => ({
      tokens,
    }))
    failWrites = true
    const fresh = { ...tokens, access_token: "new" }
    await new CredentialStore(dir, async () => keychain).update(cms, () => ({
      tokens: fresh,
    }))
    failWrites = false
    // The old keychain entry is still there, but the newer file record wins.
    expect(secrets.has(cms)).toBe(true)
    expect(
      await new CredentialStore(dir, async () => keychain).read(cms),
    ).toEqual({ credentials: { tokens: fresh }, storage: "file" })
  })

  it("does not report a sign-out while the tokens stay in the keychain", async () => {
    const secrets = new Map<string, string>()
    const keychain: Keychain = {
      get: async (account) => secrets.get(account),
      set: async (account, secret) => {
        secrets.set(account, secret)
      },
      delete: async () => {
        throw new Error("User interaction is not allowed")
      },
    }
    const store = new CredentialStore(await directory(), async () => keychain)
    await store.update(cms, () => ({ tokens }))
    await expect(store.update(cms, () => ({}))).rejects.toMatchObject({
      code: "KEYCHAIN_ERROR",
    })
  })

  it("lives in XDG_CONFIG_HOME or ~/.config", () => {
    expect(configDirectory({ XDG_CONFIG_HOME: "/x" })).toBe("/x/fulldev")
    expect(configDirectory({})).toMatch(/\.config\/fulldev$/)
    expect(keychainService).toBe("fulldev")
  })

  it("keeps one keychain entry per product server and no file", async () => {
    const { secrets, keychain } = memoryKeychain()
    const store = new CredentialStore(await directory(), async () => keychain)
    await store.update(cms, () => ({ tokens, email: "a@example.com" }))
    await store.update(connect, () => ({
      tokens: { ...tokens, access_token: "c" },
    }))
    expect([...secrets.keys()]).toEqual([cms, connect])
    expect(await store.read(cms)).toEqual({
      credentials: { tokens, email: "a@example.com" },
      storage: "keychain",
    })
    expect((await store.get(connect)).tokens?.access_token).toBe("c")
    expect(await exists(store.filePath)).toBe(false)
    expect(await store.storage()).toBe("keychain")

    await store.update(cms, () => ({}))
    expect([...secrets.keys()]).toEqual([connect])
    expect(await store.get(cms)).toEqual({})
  })

  it("falls back to a private file when the keychain cannot load", async () => {
    const store = new CredentialStore(await directory(), async () => {
      throw new Error("No Secret Service")
    })
    await store.update(cms, () => ({ tokens }))
    expect(await store.read(cms)).toEqual({
      credentials: { tokens },
      storage: "file",
    })
    expect(await store.storage()).toBe("file")
    expect(store.keychainError).toBe("No Secret Service")
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600)
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual({
      version: 2,
      servers: { [cms]: { tokens, writtenAt: expect.any(Number) } },
    })
    await store.update(cms, () => ({}))
    expect(await exists(store.filePath)).toBe(false)
  })

  it("falls back to the file when the keychain rejects a write", async () => {
    const { keychain } = memoryKeychain({ failWrites: true })
    const store = new CredentialStore(await directory(), async () => keychain)
    await store.update(cms, () => ({ tokens }))
    expect((await store.read(cms)).storage).toBe("file")
    expect(store.keychainError).toBe("The secret is too large")
  })

  it("finds file credentials when the keychain has none", async () => {
    const dir = await directory()
    const fileOnly = new CredentialStore(dir, async () => {
      throw new Error("locked")
    })
    await fileOnly.update(cms, () => ({ tokens }))
    const { keychain } = memoryKeychain()
    const store = new CredentialStore(dir, async () => keychain)
    expect(await store.read(cms)).toEqual({
      credentials: { tokens },
      storage: "file",
    })
    // The next write moves it into the keychain and out of the file.
    await store.update(cms, (current) => ({ ...current, email: "e" }))
    expect((await store.read(cms)).storage).toBe("keychain")
    expect(await exists(store.filePath)).toBe(false)
  })

  it("removes the 0.1.0 credentials file once and reports who was signed in", async () => {
    const dir = await directory()
    const { keychain } = memoryKeychain()
    const store = new CredentialStore(dir, async () => keychain)
    await writeFile(
      store.legacyPath,
      JSON.stringify({
        servers: {
          [cms]: { client: { client_id: "dcr" }, tokens, savedAt: 1 },
          "https://preview.example.com/mcp": { client: { client_id: "p" } },
        },
      }),
    )
    expect(await store.migrate()).toEqual([
      {
        url: cms,
        credentials: { client: { client_id: "dcr" }, tokens, savedAt: 1 },
      },
    ])
    expect(await exists(store.legacyPath)).toBe(false)
    expect(await store.get(cms)).toEqual({})
    expect(await store.migrate()).toEqual([])
  })
})

describe("withLock", () => {
  it("lets one action at a time hold the lock", async () => {
    const lock = join(await directory(), "auth.lock")
    const events: Array<string> = []
    const action = (name: string) => async () => {
      events.push(`${name} start`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      events.push(`${name} end`)
    }
    await Promise.all([
      withLock(lock, action("a")),
      withLock(lock, action("b")),
      withLock(lock, action("c")),
    ])
    for (let index = 0; index < events.length; index += 2)
      expect(events[index + 1]).toBe(events[index]!.replace("start", "end"))
    expect(await exists(lock)).toBe(false)
  })

  it("serializes credential updates, so none is lost", async () => {
    const { keychain } = memoryKeychain()
    const store = new CredentialStore(await directory(), async () => keychain)
    await store.update(cms, () => ({ savedAt: 0 }))
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.update(cms, (current) => ({
          savedAt: (current.savedAt ?? 0) + 1,
        })),
      ),
    )
    expect((await store.get(cms)).savedAt).toBe(10)
  })

  it("is reentrant inside the same action", async () => {
    const lock = join(await directory(), "auth.lock")
    expect(
      await withLock(lock, () => withLock(lock, async () => "nested")),
    ).toBe("nested")
  })

  it("takes over a lock left by a process that ended", async () => {
    const lock = join(await directory(), "auth.lock")
    const ended = spawnSync(process.execPath, ["-e", "process.pid"]).pid
    await writeFile(lock, String(ended))
    expect(await withLock(lock, async () => "taken", { timeoutMs: 1000 })).toBe(
      "taken",
    )
  })

  it("gives up while another live process holds the lock", async () => {
    const lock = join(await directory(), "auth.lock")
    await writeFile(lock, String(process.ppid))
    await expect(
      withLock(lock, async () => "never", { timeoutMs: 100 }),
    ).rejects.toThrow(/Another fulldev process holds/)
  })
})
