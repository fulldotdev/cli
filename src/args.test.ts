import { describe, expect, it } from "vite-plus/test"

import { helpText, parseCommandLine } from "./args.ts"
import { UsageError } from "./errors.ts"
import { products } from "./products.ts"

describe("parseCommandLine", () => {
  it("reads product commands with the product's default server", () => {
    expect(parseCommandLine(["cms", "tools"], {})).toMatchObject({
      kind: "tools",
      target: { name: "cms", url: "https://cms.full.dev/mcp" },
      session: { login: true, browser: true },
    })
    expect(parseCommandLine(["connect", "tools", "x"], {})).toMatchObject({
      kind: "tools",
      name: "x",
      target: { name: "connect", url: "https://connect.full.dev/mcp" },
    })
    expect(parseCommandLine(["scan", "instructions"], {})).toMatchObject({
      kind: "instructions",
      target: { url: "https://scan.full.dev/mcp" },
    })
  })

  it("reads call input from the argument, stdin and --file", () => {
    expect(
      parseCommandLine(["cms", "call", "read_file", "-"], {}),
    ).toMatchObject({ kind: "call", tool: "read_file", json: "-" })
    expect(
      parseCommandLine(["cms", "call", "read_file", "-f", "in.json"], {}),
    ).toMatchObject({ file: "in.json" })
    expect(parseCommandLine(["cms", "call", "x", '{"a":1}'], {})).toMatchObject(
      {
        json: '{"a":1}',
      },
    )
  })

  it("reads cms form wait with a timeout", () => {
    expect(
      parseCommandLine(["cms", "form", "wait", "b", "f", "--timeout", "5"], {}),
    ).toMatchObject({
      kind: "form-wait",
      branchId: "b",
      formId: "f",
      timeoutMinutes: 5,
    })
    expect(
      parseCommandLine(["cms", "form", "wait", "b", "f"], {}),
    ).toMatchObject({ timeoutMinutes: 30 })
  })

  it("defaults login, logout and status to every product", () => {
    for (const kind of ["login", "logout", "status"] as const) {
      const command = parseCommandLine([kind], {})
      expect(command.kind).toBe(kind)
      expect(
        "targets" in command && command.targets.map((t) => t.name),
      ).toEqual(products.map((product) => product.name))
    }
    expect(parseCommandLine(["login", "cms", "cms"], {})).toMatchObject({
      targets: [{ name: "cms" }],
      browser: true,
    })
    expect(
      parseCommandLine(["login", "connect", "--no-browser"], {}),
    ).toMatchObject({ browser: false })
  })

  it("turns off sign-in and the browser for product commands", () => {
    expect(
      parseCommandLine(["cms", "tools", "--no-login", "--no-browser"], {}),
    ).toMatchObject({ session: { login: false, browser: false } })
  })

  it("shows help for each command and the version", () => {
    expect(parseCommandLine([], {})).toEqual({ kind: "help", topic: "" })
    expect(parseCommandLine(["--help"], {})).toEqual({
      kind: "help",
      topic: "",
    })
    expect(parseCommandLine(["cms"], {})).toEqual({
      kind: "help",
      topic: "cms",
    })
    expect(parseCommandLine(["cms", "--help"], {})).toEqual({
      kind: "help",
      topic: "cms",
    })
    expect(parseCommandLine(["cms", "call", "x", "-h"], {})).toEqual({
      kind: "help",
      topic: "cms call",
    })
    expect(parseCommandLine(["help", "cms", "form", "wait"], {})).toEqual({
      kind: "help",
      topic: "cms form wait",
    })
    expect(parseCommandLine(["help", "login"], {})).toEqual({
      kind: "help",
      topic: "login",
    })
    expect(parseCommandLine(["-v"], {})).toEqual({ kind: "version" })
    expect(parseCommandLine(["cms", "--version"], {})).toEqual({
      kind: "version",
    })
  })

  it.each([
    [["frobnicate"]],
    [["tools"]],
    [["call", "x"]],
    [["cms", "frobnicate"]],
    [["cms", "call"]],
    [["cms", "call", "a", "b", "c"]],
    [["cms", "tools", "a", "b"]],
    [["cms", "instructions", "a"]],
    [["cms", "form", "wait", "branch"]],
    [["cms", "form", "send", "a", "b"]],
    [["connect", "form", "wait", "a", "b"]],
    [["scan", "form", "wait", "a", "b"]],
    [["cms", "tools", "--file", "x.json"]],
    [["cms", "call", "x", "--timeout", "3"]],
    [["cms", "form", "wait", "a", "b", "--timeout", "0"]],
    [["cms", "form", "wait", "a", "b", "--timeout", "soon"]],
    [["cms", "tools", "--device"]],
    [["cms", "tools", "--unknown"]],
    [["login", "nope"]],
    [["login", "--no-login"]],
    [["login", "--device"]],
    [["login", "--url", "https://x.example/mcp"]],
    [["login", "cms", "connect", "--url", "https://x.example/mcp"]],
    [["cms", "tools", "--url", "not a url"]],
    [["cms", "tools", "--url", "ftp://example.com/mcp"]],
    [["help", "cms", "frobnicate"]],
    [["help", "connect", "form"]],
  ])("rejects %j as a usage error", (argv) => {
    expect(() => parseCommandLine(argv, {})).toThrow(UsageError)
  })

  it("points a usage error to the help of its command", () => {
    try {
      parseCommandLine(["cms", "call"], {})
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as UsageError).details.help).toBe("fulldev cms call --help")
      expect((error as UsageError).exitCode).toBe(64)
    }
  })
})

describe("helpText", () => {
  it("lists every product and the exit codes at the root", () => {
    const text = helpText("")!
    for (const product of products) expect(text).toContain(product.name)
    expect(text).toContain("64 usage error")
    expect(text).toContain("fulldev cms form wait")
  })

  it("shows form wait only for cms", () => {
    expect(helpText("cms")).toContain("fulldev cms form wait")
    expect(helpText("connect")).not.toContain("connect form")
    expect(helpText("connect form wait")).toBeUndefined()
  })

  it("explains a subcommand with its options", () => {
    const text = helpText("cms call")!
    expect(text).toContain("Usage: fulldev cms call <tool>")
    expect(text).toContain("--file")
    expect(text).not.toContain("--timeout")
    expect(helpText("login")).toContain("--no-browser")
  })

  it("never uses an em dash", () => {
    const topics = [
      "",
      "login",
      "logout",
      "status",
      "help",
      ...products.flatMap((product) => [
        product.name,
        `${product.name} tools`,
        `${product.name} call`,
        `${product.name} instructions`,
      ]),
      "cms form wait",
    ]
    for (const topic of topics)
      expect(helpText(topic)).not.toContain(String.fromCharCode(0x2014))
  })
})
