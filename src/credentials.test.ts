import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vite-plus/test"

import { CredentialStore, credentialsPath } from "./credentials.ts"

const tokens = { access_token: "a", token_type: "Bearer", refresh_token: "r" }
const client = {
  client_id: "c",
  redirect_uris: ["http://127.0.0.1:1/callback"],
}

async function store(serverUrl = "https://cms.full.dev/mcp") {
  const dir = await mkdtemp(join(tmpdir(), "fulldev-"))
  return new CredentialStore(
    serverUrl,
    join(dir, "fulldev", "credentials.json"),
  )
}

describe("credentials", () => {
  it("lives in XDG_CONFIG_HOME or ~/.config", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/x" })).toBe(
      "/x/fulldev/credentials.json",
    )
    expect(credentialsPath({})).toMatch(/\.config\/fulldev\/credentials\.json$/)
  })

  it("writes a file only the user can read, in a private folder", async () => {
    const credentials = await store()
    await credentials.update(() => ({ client, tokens }))
    expect((await stat(credentials.path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(credentials.path, ".."))).mode & 0o777).toBe(0o700)
  })

  it("tightens a file that was readable by others", async () => {
    const credentials = await store()
    await credentials.update(() => ({ client }))
    await writeFile(credentials.path, await readFile(credentials.path), {
      mode: 0o644,
    })
    await credentials.update((current) => ({ ...current, tokens }))
    expect((await stat(credentials.path)).mode & 0o777).toBe(0o600)
  })

  it("keeps each server apart", async () => {
    const production = await store()
    const preview = new CredentialStore(
      "https://deploy-preview-1--cms.netlify.app/mcp",
      production.path,
    )
    await production.update(() => ({ client, tokens }))
    await preview.update(() => ({ client: { client_id: "p" } }))
    expect(await production.get()).toEqual({ client, tokens })
    expect(await preview.get()).toEqual({ client: { client_id: "p" } })
  })

  it("logs out by removing tokens and keeping the client", async () => {
    const credentials = await store()
    await credentials.update(() => ({ client, tokens, savedAt: 1 }))
    await credentials.update(({ client: kept }) =>
      kept ? { client: kept } : {},
    )
    expect(await credentials.get()).toEqual({ client })
  })

  it("deletes the file when nothing is left", async () => {
    const credentials = await store()
    await credentials.update(() => ({ tokens }))
    await credentials.update(() => ({}))
    await expect(stat(credentials.path)).rejects.toThrow(/ENOENT/)
    expect(await credentials.get()).toEqual({})
  })
})
