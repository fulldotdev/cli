import { describe, expect, it } from "vite-plus/test"

import { defaultUrl, parseCommandLine, UsageError } from "./args.ts"

describe("parseCommandLine", () => {
  it("uses the default server and options", () => {
    const line = parseCommandLine(["tools"], {})
    expect(line).toMatchObject({
      command: "tools",
      args: [],
      url: defaultUrl,
      login: true,
      browser: true,
      timeoutMinutes: 30,
    })
  })

  it("takes the server from --url before FULLDEV_URL", () => {
    const env = { FULLDEV_URL: "https://preview.example.com/mcp" }
    expect(parseCommandLine(["status"], env).url).toBe(env.FULLDEV_URL)
    expect(
      parseCommandLine(
        ["status", "--url", "https://other.example.com/mcp"],
        env,
      ).url,
    ).toBe("https://other.example.com/mcp")
  })

  it("reads call arguments, stdin and --file", () => {
    expect(parseCommandLine(["call", "read_file", "-"], {}).args).toEqual([
      "read_file",
      "-",
    ])
    expect(
      parseCommandLine(["call", "read_file", "-f", "input.json"], {}).file,
    ).toBe("input.json")
    expect(parseCommandLine(["call", "x", '{"a":1}'], {}).args[1]).toBe(
      '{"a":1}',
    )
  })

  it("reads form wait with a timeout", () => {
    const line = parseCommandLine(
      ["form", "wait", "branch", "form", "--timeout", "5"],
      {},
    )
    expect(line.args).toEqual(["wait", "branch", "form"])
    expect(line.timeoutMinutes).toBe(5)
  })

  it("turns off sign-in and the browser", () => {
    const line = parseCommandLine(["tools", "--no-login", "--no-browser"], {})
    expect(line.login).toBe(false)
    expect(line.browser).toBe(false)
  })

  it("allows help and version without a command", () => {
    expect(parseCommandLine([], {}).command).toBeUndefined()
    expect(parseCommandLine(["--help"], {}).help).toBe(true)
    expect(parseCommandLine(["-v"], {}).version).toBe(true)
  })

  it.each([
    [["frobnicate"]],
    [["call"]],
    [["call", "a", "b", "c"]],
    [["tools", "a", "b"]],
    [["form", "wait", "branch"]],
    [["form", "send", "a", "b"]],
    [["tools", "--file", "x.json"]],
    [["call", "x", "--timeout", "3"]],
    [["form", "wait", "a", "b", "--timeout", "0"]],
    [["form", "wait", "a", "b", "--timeout", "soon"]],
    [["tools", "--url", "not a url"]],
    [["tools", "--url", "ftp://example.com/mcp"]],
    [["tools", "--unknown"]],
  ])("rejects %j", (argv) => {
    expect(() => parseCommandLine(argv, {})).toThrow(UsageError)
  })
})
