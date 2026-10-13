import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type * as McpClient from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import type { CredentialStore } from "./credentials.ts"
import { main } from "./main.ts"
import type * as OAuth from "./oauth.ts"

const callTool = vi.hoisted(() => vi.fn())
const listTools = vi.hoisted(() => vi.fn())
const connect = vi.hoisted(() => vi.fn())
vi.mock("@modelcontextprotocol/client", async (original) => ({
  ...(await original<typeof McpClient>()),
  Client: class {
    connect = connect
    callTool = callTool
    listTools = listTools
    close = async () => {}
  },
  StreamableHTTPClientTransport: class {},
}))
vi.mock("./oauth.ts", async (original) => ({
  ...(await original<typeof OAuth>()),
  StoredTokenAuth: class {
    token = async () => "private-token"
    onUnauthorized = async () => {}
  },
}))

const signedIn = {
  get: async () => ({ tokens: { access_token: "t", token_type: "Bearer" } }),
} as unknown as CredentialStore

async function run(argv: Array<string>) {
  let stdout = ""
  let stderr = ""
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    interactive: false,
    env: {},
    store: signedIn,
  })
  return { code, stdout, stderr }
}

const markdown = "# Plan\r\n\r\n\t- Café ✓ 👩🏽‍💻\n  indented\n\n"

async function textFile(content: string) {
  const path = join(await mkdtemp(join(tmpdir(), "fulldev-text-")), "page.md")
  await writeFile(path, content)
  return path
}

const structured = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
})

beforeEach(() => {
  connect.mockReset().mockResolvedValue(undefined)
  callTool.mockReset()
  listTools.mockReset().mockResolvedValue({ tools: [] })
})

/** cms_commit_files as the server lists it: revision is a string, more may come. */
const commitFiles = {
  name: "cms_commit_files",
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: {
      revision: { type: "string" },
      pullRequest: {
        type: "object",
        properties: { number: { type: "number" } },
        additionalProperties: {},
      },
    },
    required: ["revision"],
    additionalProperties: {},
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}

describe("call with --text-file and --raw", () => {
  it("sends the exact text with the JSON input, its version and organization", async () => {
    callTool.mockResolvedValue(structured({ pageId: "p", version: 8 }))
    const path = await textFile(markdown)
    const { code, stdout } = await run([
      "pages",
      "call",
      "update_page",
      '{"pageId":"p","expectedVersion":7,"content":{"blocks":[{"type":"text"}]}}',
      "--text-file",
      `content.blocks.0.markdown=${path}`,
      "--org",
      "acme",
    ])
    expect(code).toBe(0)
    expect(callTool.mock.calls[0]![0]).toEqual({
      name: "pages_update_page",
      arguments: {
        pageId: "p",
        expectedVersion: 7,
        content: { blocks: [{ type: "text", markdown }] },
        organization: "acme",
      },
    })
    expect(stdout).toBe(
      `${JSON.stringify({ pageId: "p", version: 8 }, null, 2)}\n`,
    )
    expect(listTools).not.toHaveBeenCalled()
  })

  it("prints a text field of the result exactly, from structured or text content", async () => {
    callTool.mockResolvedValueOnce(structured({ markdown, version: 3 }))
    expect(
      await run(["pages", "call", "export_page_markdown", "--raw", "markdown"]),
    ).toEqual({ code: 0, stdout: markdown, stderr: "" })
    callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ file: { markdown } }) }],
    })
    expect(
      (await run(["cms", "call", "read_file", "--raw", "file.markdown"]))
        .stdout,
    ).toBe(markdown)
    callTool.mockResolvedValueOnce(structured({ notes: "" }))
    expect(await run(["work", "call", "get_task", "--raw", "notes"])).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    })
  })

  it.each([
    [{ pageId: "new", version: 1 }, /markdown is missing/],
    [{ markdown: 3 }, /markdown is a number/],
    [{ markdown: null }, /markdown is null/],
  ])(
    "keeps the result of a call that succeeded when the field is not text: %j",
    async (data, message) => {
      callTool.mockResolvedValue(structured(data))
      const { code, stdout, stderr } = await run([
        "pages",
        "call",
        "create_page",
        "--raw",
        "markdown",
      ])
      expect(code).toBe(1)
      expect(stdout).toBe("")
      expect(JSON.parse(stderr).error).toEqual({
        code: "RAW_NOT_TEXT",
        message: expect.stringMatching(message),
        succeeded: true,
        result: data,
      })
      expect(JSON.parse(stderr).error.message).toMatch(
        /^The request succeeded and any change it made is kept.*do not send the request again\.$/,
      )
      expect(callTool).toHaveBeenCalledTimes(1)
    },
  )

  it("says a read-only tool changed nothing when its field is not text", async () => {
    listTools.mockResolvedValue({
      tools: [
        {
          name: "pages_get_page",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    })
    callTool.mockResolvedValue(structured({ pageId: "p" }))
    const { stderr } = await run(["pages", "call", "get_page", "--raw", "x"])
    expect(JSON.parse(stderr).error.message).toMatch(
      /^The request succeeded, but --raw x needs text.*under "result"\.$/,
    )
  })

  it("refuses a field the output schema rules out before calling the tool", async () => {
    listTools.mockResolvedValue({ tools: [commitFiles] })
    for (const field of ["revision.sha", "pullRequest.number"]) {
      const { code, stdout, stderr } = await run([
        "cms",
        "call",
        "commit_files",
        '{"branchId":"b","expectedRevision":"old","changes":[{"path":"a.md","content":"x"}]}',
        "--raw",
        field,
      ])
      expect(code).toBe(64)
      expect(stdout).toBe("")
      expect(JSON.parse(stderr).error).toMatchObject({
        code: "USAGE",
        message: expect.stringMatching(
          /can never be text.*Nothing was sent\.$/,
        ),
        help: "fulldev tools cms_commit_files",
      })
    }
    expect(callTool).not.toHaveBeenCalled()
  })

  it("calls the tool when its output schema allows text at the field", async () => {
    listTools.mockResolvedValue({ tools: [commitFiles] })
    callTool.mockResolvedValue(structured({ revision: "abc123" }))
    expect(
      await run(["cms", "call", "commit_files", "--raw", "revision"]),
    ).toEqual({ code: 0, stdout: "abc123", stderr: "" })
    // Not declared, but the schema allows more properties: the call goes out.
    const { code, stderr } = await run([
      "cms",
      "call",
      "commit_files",
      "--raw",
      "markdown",
    ])
    expect(code).toBe(1)
    expect(JSON.parse(stderr).error).toMatchObject({
      succeeded: true,
      result: { revision: "abc123" },
    })
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it("prints a tool's error with its details and nothing on stdout", async () => {
    const error = {
      code: "VERSION_CONFLICT",
      message: "The page changed.",
      currentVersion: 9,
    }
    callTool.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error }) }],
    })
    const { code, stdout, stderr } = await run([
      "pages",
      "call",
      "export_page_markdown",
      "--raw",
      "markdown",
    ])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toEqual({ error })
  })

  it.each([
    [['{"content":"old"}', "--text-file", "content=PATH"], /already has/],
    [["{}", "--text-file", "__proto__.x=PATH"], /__proto__/],
    [["-", "--text-file", "content=-"], /stdin/],
    [
      ["{}", "--text-file", "content=PATH", "--text-file", "content=PATH"],
      /twice/,
    ],
    [["--raw", "markdown", "--all-orgs"], /--raw/],
  ])("refuses %j before connecting", async (args, message) => {
    const path = await textFile("text")
    const { code, stdout, stderr } = await run([
      "pages",
      "call",
      "update_page",
      ...args.map((arg) => arg.replace("PATH", path)),
    ])
    expect(code).toBe(64)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr).error.message).toMatch(message)
    expect(connect).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })
})

describe("api with --text-file and --raw", () => {
  const spec = {
    paths: {
      "/pages/update": { post: { operationId: "pages.update" } },
      "/pages/exportMarkdown": {
        get: { operationId: "pages.exportMarkdown" },
      },
    },
    components: {
      schemas: {
        Receipt: {
          type: "object",
          properties: {
            pageId: { type: "string" },
            version: { type: "integer" },
          },
        },
      },
    },
  }
  const fetchFn = vi.fn<typeof fetch>()
  beforeEach(() => {
    fetchFn.mockReset()
    vi.stubGlobal("fetch", fetchFn)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const answer = (
    body: unknown,
    status = 200,
    create?: unknown,
    mediaType = "application/json",
  ) =>
    fetchFn.mockImplementation(async (url) =>
      new Request(url).url.endsWith("openapi.json")
        ? Response.json({
            ...spec,
            paths: { ...spec.paths, "/pages/create": { post: create } },
          })
        : Response.json(body, {
            status,
            headers: { "content-type": mediaType },
          }),
    )
  const creates = (schema: unknown) => ({
    operationId: "pages.create",
    responses: { "200": { content: { "application/json": { schema } } } },
  })

  it("posts the exact text and prints a raw field", async () => {
    answer({ markdown, version: 4 })
    const path = await textFile(markdown)
    const { code, stdout } = await run([
      "api",
      "pages.pages.update",
      '{"pageId":"p","expectedVersion":3}',
      "--text-file",
      `markdown=${path}`,
      "--raw",
      "markdown",
    ])
    expect(code).toBe(0)
    expect(stdout).toBe(markdown)
    const init = fetchFn.mock.calls[1]![1]
    expect(JSON.parse(init!.body as string)).toEqual({
      pageId: "p",
      expectedVersion: 3,
      markdown,
    })
  })

  it("keeps a conflict's details and prints nothing on stdout", async () => {
    answer(
      {
        defined: true,
        code: "CONFLICT",
        status: 409,
        message: "The page changed.",
        data: { currentVersion: 9 },
      },
      409,
    )
    const { code, stdout, stderr } = await run([
      "api",
      "pages.pages.exportMarkdown",
      '{"pageId":"p"}',
      "--raw",
      "markdown",
    ])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "CONFLICT",
        message: "The page changed.",
        status: 409,
        data: { currentVersion: 9 },
      },
    })
  })

  it("refuses a field the response schema rules out before sending", async () => {
    answer(
      { pageId: "p-new", version: 1 },
      200,
      creates({ $ref: "#/components/schemas/Receipt" }),
    )
    const { code, stdout, stderr } = await run([
      "api",
      "pages.pages.create",
      "{}",
      "--raw",
      "version",
    ])
    expect(code).toBe(64)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr).error.message).toBe(
      "--raw version can never be text: the API's response schema says version is an integer. Nothing was sent.",
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("keeps the receipt when a change succeeded under an open schema", async () => {
    // How the server describes every response today: anything.
    answer(
      { pageId: "p-new", version: 1 },
      200,
      creates({ anyOf: [{}, { not: {} }] }),
    )
    const { code, stdout, stderr } = await run([
      "api",
      "pages.pages.create",
      "{}",
      "--raw",
      "markdown",
    ])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr).error).toMatchObject({
      code: "RAW_NOT_TEXT",
      message: expect.stringMatching(/^The request succeeded and any change/),
      succeeded: true,
      result: { pageId: "p-new", version: 1 },
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["default success response", "default", "application/json", 201],
    ["alternative representation", "200", "application/vnd.fulldev+json", 200],
  ])(
    "allows text declared by an %s",
    async (_, status, mediaType, responseStatus) => {
      const nontext = {
        type: "object",
        properties: { markdown: { type: "number" } },
      }
      const text = {
        type: "object",
        properties: { markdown: { type: "string" } },
      }
      const responses: Record<
        string,
        { content: Record<string, { schema: unknown }> }
      > = {
        "200": { content: { "application/json": { schema: nontext } } },
      }
      responses[status] ??= { content: {} }
      responses[status]!.content[mediaType] = { schema: text }
      answer(
        { markdown },
        responseStatus,
        {
          operationId: "pages.create",
          responses,
        },
        mediaType,
      )
      const { code, stdout } = await run([
        "api",
        "pages.pages.create",
        "{}",
        "--raw",
        "markdown",
      ])
      expect(code).toBe(0)
      expect(stdout).toBe(markdown)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    },
  )

  it("refuses a conflicting text before sending the change", async () => {
    answer({})
    const path = await textFile("text")
    const { code } = await run([
      "api",
      "pages.pages.update",
      '{"markdown":"old"}',
      "--text-file",
      `markdown=${path}`,
    ])
    expect(code).toBe(64)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(new Request(fetchFn.mock.calls[0]![0]).url).toMatch(/openapi\.json$/)
  })
})
