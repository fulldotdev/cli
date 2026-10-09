import { describe, expect, it } from "vite-plus/test"

import { helpText, parseCommandLine } from "./args.ts"
import { UsageError } from "./errors.ts"
import { apps } from "./apps.ts"

describe("parseCommandLine", () => {
  it("reads commands for every app and for one, on the one server", () => {
    const target = { url: "https://app.full.dev/mcp" }
    expect(parseCommandLine(["tools"], {})).toMatchObject({
      kind: "tools",
      app: undefined,
      target,
      session: { login: true, browser: true },
    })
    expect(parseCommandLine(["cms", "tools"], {})).toMatchObject({
      kind: "tools",
      app: { name: "cms" },
      target,
    })
    expect(parseCommandLine(["connect", "tools", "x"], {})).toMatchObject({
      kind: "tools",
      name: "x",
      app: { name: "connect" },
    })
    expect(parseCommandLine(["scan", "instructions"], {})).toMatchObject({
      kind: "instructions",
      app: { name: "scan" },
    })
    expect(parseCommandLine(["instructions"], {})).toMatchObject({
      kind: "instructions",
      app: undefined,
    })
  })

  it("names a tool in full, also after its app without the prefix", () => {
    expect(parseCommandLine(["call", "cms_read_file"], {})).toMatchObject({
      kind: "call",
      tool: "cms_read_file",
    })
    for (const name of ["read_file", "cms_read_file"])
      expect(parseCommandLine(["cms", "call", name], {})).toMatchObject({
        tool: "cms_read_file",
      })
  })

  it("reads call input from the argument, stdin and --file", () => {
    expect(
      parseCommandLine(["cms", "call", "read_file", "-"], {}),
    ).toMatchObject({ kind: "call", tool: "cms_read_file", json: "-" })
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
      app: { name: "cms" },
      branchId: "b",
      formId: "f",
      timeoutMinutes: 5,
    })
    expect(
      parseCommandLine(["cms", "form", "wait", "b", "f"], {}),
    ).toMatchObject({ timeoutMinutes: 30 })
  })

  it("signs in, out and shows the status once, for every app", () => {
    for (const kind of ["login", "logout", "status"] as const)
      expect(parseCommandLine([kind], {})).toMatchObject({
        kind,
        target: { title: "Fulldev", url: "https://app.full.dev/mcp" },
      })
    expect(parseCommandLine(["login"], {})).toMatchObject({ browser: true })
    expect(parseCommandLine(["login", "--no-browser"], {})).toMatchObject({
      browser: false,
    })
    expect(
      parseCommandLine(["login", "--url", "https://p.example/mcp"], {}),
    ).toMatchObject({
      target: { url: "https://p.example/mcp", urlFromFlag: true },
    })
  })

  it("turns off sign-in and the browser for app commands", () => {
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
    [["call"]],
    [["tools", "a", "b"]],
    [["instructions", "a"]],
    [["form", "wait", "a", "b"]],
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
    [["login", "cms"]],
    [["status", "cms"]],
    [["login", "--no-login"]],
    [["login", "--device"]],
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
  it("lists every app, the server and the exit codes at the root", () => {
    const text = helpText("")!
    for (const app of apps) expect(text).toContain(app.name)
    expect(text).toContain("64 usage error")
    expect(text).toContain("fulldev cms form wait")
    expect(text).toContain("fulldev tools [name]")
    expect(text).toContain("https://app.full.dev/mcp (FULLDEV_URL")
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
      "instructions",
      "tools",
      "call",
      ...apps.flatMap((app) => [
        app.name,
        `${app.name} tools`,
        `${app.name} call`,
        `${app.name} instructions`,
      ]),
      "cms form wait",
    ]
    for (const topic of topics)
      expect(helpText(topic)).not.toContain(String.fromCharCode(0x2014))
  })
})
