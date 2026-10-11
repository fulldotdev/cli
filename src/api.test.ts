import { describe, expect, it, vi, beforeEach } from "vite-plus/test"

import { runApi } from "./api.ts"
import { parseCommandLine } from "./args.ts"
import { SignInRequiredError } from "./errors.ts"
import type { Io } from "./main.ts"
import { CredentialStore } from "./credentials.ts"

const token = vi.hoisted(() =>
  vi.fn(async () => "private-token" as string | undefined),
)
const refresh = vi.hoisted(() => vi.fn(async () => {}))
const login = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("./oauth.ts", () => ({
  StoredTokenAuth: class {
    token = token
    onUnauthorized = refresh
  },
  browserLogin: login,
}))

const io: Io = {
  interactive: false,
  stdout: vi.fn(),
  stderr: vi.fn(),
  env: {},
  store: new CredentialStore("/unused"),
}
const spec = {
  paths: {
    "/records/list": {
      get: { operationId: "records.list", summary: "List records" },
    },
    "/records/update": { post: { operationId: "records.update" } },
  },
}
const command = (args: Array<string>) => {
  const parsed = parseCommandLine(args, {})
  if (parsed.kind !== "api") throw new Error("Expected an API command")
  return parsed
}

beforeEach(() => {
  token.mockReset().mockResolvedValue("private-token")
  refresh.mockReset().mockResolvedValue(undefined)
  login.mockReset().mockResolvedValue(undefined)
})

describe("HTTP API command", () => {
  it.each(["get", "post"])(
    "encodes %s path input separately from query and body",
    async (method) => {
      const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
        const actual = new URL(new Request(url).url)
        if (actual.pathname.endsWith("openapi.json"))
          return Response.json({
            paths: {
              "/records/{id}": { [method]: { operationId: "records.item" } },
            },
          })
        expect(actual.pathname).toBe("/contacts/api/v1/records/a%2Fb%20%3F%23")
        expect(actual.searchParams.has("id")).toBe(false)
        if (method === "get") {
          expect(actual.searchParams.get("enabled")).toBe("false")
          expect(init?.body).toBeUndefined()
        } else expect(init?.body).toBe('{"enabled":false}')
        return Response.json({ ok: true })
      })
      await runApi(
        command([
          "api",
          "contacts.records.item",
          '{"id":"a/b ?#","enabled":false}',
        ]),
        io,
        fetchFn,
      )
    },
  )
  it.each([{}, { id: null }, { id: {} }, { id: ".." }])(
    "rejects missing or invalid path input before authenticating: %j",
    async (input) => {
      const fetchFn = vi.fn<typeof fetch>(async () =>
        Response.json({
          paths: { "/records/{id}": { get: { operationId: "records.item" } } },
        }),
      )
      await expect(
        runApi(
          command(["api", "contacts.records.item", JSON.stringify(input)]),
          io,
          fetchFn,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" })
      expect(token).not.toHaveBeenCalled()
    },
  )
  it("supports both command forms, input files and organization selection", () => {
    expect(
      command(["api", "contacts.records.list", "{}", "--org", "first"]),
    ).toMatchObject({
      app: { name: "contacts" },
      operation: "records.list",
      organization: "first",
    })
    expect(
      command(["contacts", "api", "records.list", "--file", "input.json"]),
    ).toMatchObject({ operation: "records.list", file: "input.json" })
  })
  it("discovers all HTTP operations without signing in", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(spec))
    expect(await runApi(command(["api", "contacts"]), io, fetchFn)).toEqual([
      {
        path: "/records/list",
        method: "GET",
        operationId: "records.list",
        summary: "List records",
      },
      {
        path: "/records/update",
        method: "POST",
        operationId: "records.update",
      },
    ])
    expect(token).not.toHaveBeenCalled()
  })
  it("encodes GET input and sends credentials only to the chosen server", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      if (new Request(url).url.endsWith("openapi.json"))
        return Response.json(spec)
      const actual = new URL(new Request(url).url)
      expect(actual.origin).toBe("https://preview.example")
      expect(actual.searchParams.get("enabled")).toBe("false")
      expect(actual.searchParams.get("limit")).toBe("3")
      expect(init?.redirect).toBe("error")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer private-token",
      )
      expect(new Headers(init?.headers).get("x-fulldev-organization")).toBe(
        "first",
      )
      return Response.json({ records: [] })
    })
    expect(
      await runApi(
        command([
          "api",
          "contacts.records.list",
          '{"limit":3,"enabled":false}',
          "--org",
          "first",
          "--url",
          "https://preview.example/mcp",
        ]),
        io,
        fetchFn,
      ),
    ).toEqual({ records: [] })
  })
  it("sends POST input and preserves actionable permission failures", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      if (new Request(url).url.endsWith("openapi.json"))
        return Response.json(spec)
      expect(init?.method).toBe("POST")
      expect(init?.body).toBe('{"id":"r"}')
      return Response.json(
        { code: "FORBIDDEN", message: "Admin access required." },
        { status: 403 },
      )
    })
    await expect(
      runApi(
        command(["api", "contacts.records.update", '{"id":"r"}']),
        io,
        fetchFn,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Admin access required.",
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
  it("rejects unknown operations and paths outside the app before obtaining credentials", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(spec))
    await expect(
      runApi(command(["api", "contacts.nope"]), io, fetchFn),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    const invalid = vi.fn<typeof fetch>(async () =>
      Response.json({
        paths: { "/../../elsewhere": { post: { operationId: "escape" } } },
      }),
    )
    await expect(
      runApi(command(["api", "contacts.escape"]), io, invalid),
    ).rejects.toMatchObject({ code: "INVALID_API" })
    expect(token).not.toHaveBeenCalled()
  })
  it("reports a sign-in requirement without an interactive prompt", async () => {
    token.mockResolvedValue(undefined)
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(spec))
    await expect(
      runApi(command(["api", "contacts.records.list"]), io, fetchFn),
    ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it("starts interactive login when a rejected token cannot be refreshed", async () => {
    const parsed = command(["api", "contacts.records.list"])
    refresh.mockRejectedValueOnce(new SignInRequiredError(parsed.target))
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(spec))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ records: [] }))
    expect(await runApi(parsed, { ...io, interactive: true }, fetchFn)).toEqual(
      { records: [] },
    )
    expect(login).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it("starts login if a refreshed token is also rejected, with bounded retries", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(spec))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ records: [] }))
    expect(
      await runApi(
        command(["api", "contacts.records.list"]),
        { ...io, interactive: true },
        fetchFn,
      ),
    ).toEqual({ records: [] })
    expect(login).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })
  it("respects --no-login when a rejected token cannot be refreshed", async () => {
    const parsed = command(["api", "contacts.records.list", "--no-login"])
    refresh.mockRejectedValueOnce(new SignInRequiredError(parsed.target))
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(spec))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    await expect(
      runApi(parsed, { ...io, interactive: true }, fetchFn),
    ).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" })
    expect(login).not.toHaveBeenCalled()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
  it("reports non-JSON gateway errors without retrying a mutation", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url) =>
      new Request(url).url.endsWith("openapi.json")
        ? Response.json(spec)
        : new Response("Bad gateway", { status: 502 }),
    )
    await expect(
      runApi(command(["api", "contacts.records.update", "{}"]), io, fetchFn),
    ).rejects.toMatchObject({
      code: "API_FAILED",
      message: "API returned a non-JSON response (502).",
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
