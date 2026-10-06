import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vite-plus/test"

import { CredentialStore } from "./credentials.ts"
import type { Keychain } from "./credentials.ts"
import { main } from "./main.ts"
import type { Io } from "./main.ts"

async function run(
  argv: Array<string>,
  {
    interactive = false,
    env = {},
  }: { interactive?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const secrets = new Map<string, string>()
  const keychain: Keychain = {
    get: async (account) => secrets.get(account),
    set: async (account, secret) => {
      secrets.set(account, secret)
    },
    delete: async (account) => {
      secrets.delete(account)
    },
  }
  let stdout = ""
  let stderr = ""
  const io: Io = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    interactive,
    env,
    store: new CredentialStore(
      await mkdtemp(join(tmpdir(), "fulldev-")),
      async () => keychain,
    ),
  }
  const code = await main(argv, io)
  return { code, stdout, stderr }
}

describe("main", () => {
  it.each([
    [["cms", "tools"]],
    [["connect", "instructions"]],
    [["scan", "call", "list_sites", "{}"]],
    [["cms", "form", "wait", "b", "f"]],
  ])(
    "fails %j at once with exit code 3 and a JSON error without a terminal",
    async (argv) => {
      const { code, stdout, stderr } = await run(argv)
      expect(code).toBe(3)
      expect(stdout).toBe("")
      const product = argv[0]
      expect(JSON.parse(stderr)).toEqual({
        error: {
          code: "SIGN_IN_REQUIRED",
          message: expect.stringContaining(`fulldev login ${product}`),
          product,
          server: `https://${product}.full.dev/mcp`,
          command: `fulldev login ${product}`,
        },
      })
    },
  )

  it("names the --url in the login command it asks for", async () => {
    const preview = "https://deploy-preview-3--cms.netlify.app/mcp"
    const { code, stderr } = await run(["cms", "tools", "--url", preview])
    expect(code).toBe(3)
    expect(JSON.parse(stderr).error.command).toBe(
      `fulldev login cms --url ${preview}`,
    )
    const fromEnv = await run(["cms", "tools"], {
      env: { FULLDEV_CMS_URL: preview },
    })
    expect(JSON.parse(fromEnv.stderr).error).toMatchObject({
      server: preview,
      command: "fulldev login cms",
    })
  })

  it("does not sign in at a terminal with --no-login", async () => {
    const { code, stderr } = await run(["cms", "tools", "--no-login"], {
      interactive: true,
    })
    expect(code).toBe(3)
    expect(JSON.parse(stderr).error.code).toBe("SIGN_IN_REQUIRED")
  })

  it.each([
    [["frobnicate"], "fulldev --help"],
    [["cms", "call"], "fulldev cms call --help"],
    [["cms", "tools", "--bogus"], "fulldev cms tools --help"],
    [["connect", "form", "wait", "a", "b"], "fulldev connect --help"],
  ])(
    "prints a usage error for %j as JSON with exit code 64",
    async (argv, help) => {
      const { code, stdout, stderr } = await run(argv)
      expect(code).toBe(64)
      expect(stdout).toBe("")
      expect(JSON.parse(stderr)).toEqual({
        error: { code: "USAGE", message: expect.any(String), help },
      })
    },
  )

  it("prints a bad tool input as a usage error", async () => {
    const { code, stderr } = await run(["cms", "call", "x", "{bad"])
    expect(code).toBe(64)
    expect(JSON.parse(stderr).error.message).toMatch(/not valid JSON/)
  })

  it("prints help for each level on stdout", async () => {
    for (const argv of [
      [],
      ["--help"],
      ["help"],
      ["cms"],
      ["cms", "--help"],
      ["help", "cms", "call"],
      ["cms", "call", "--help"],
      ["login", "-h"],
    ]) {
      const { code, stdout, stderr } = await run(argv)
      expect(code).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("Exit codes:")
    }
    expect((await run(["cms", "call", "--help"])).stdout).toMatch(
      /^Usage: fulldev cms call/,
    )
  })

  it("prints the version", async () => {
    const { code, stdout } = await run(["--version"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it("logs out of products that are not signed in", async () => {
    const { code, stdout } = await run(["logout"])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      products: [
        { product: "cms", signedIn: false },
        { product: "connect", signedIn: false },
        { product: "scan", signedIn: false },
      ],
    })
  })

  it("reports status per product and exits 3 when one needs a sign-in", async () => {
    const { code, stdout } = await run(["status", "cms"])
    expect(code).toBe(3)
    expect(JSON.parse(stdout)).toEqual({
      storage: { kind: "keychain", service: "fulldev" },
      products: [
        { product: "cms", server: "https://cms.full.dev/mcp", signedIn: false },
      ],
    })
  })
})
