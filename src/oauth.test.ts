import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { FetchLike } from "@modelcontextprotocol/client"
import { describe, expect, it, vi } from "vite-plus/test"

import { CredentialStore } from "./credentials.ts"
import type { Keychain } from "./credentials.ts"
import { SignInRequiredError } from "./errors.ts"
import {
  StoredTokenAuth,
  browserLogin,
  clientIds,
  refreshTokens,
  revokeTokens,
} from "./oauth.ts"
import { findProduct } from "./products.ts"
import type { Target } from "./products.ts"

const issuer = "https://clerk.full.dev"
const clientId = clientIds[issuer]!
const cms: Target = { ...findProduct("cms")!, urlFromFlag: false }
const connect: Target = { ...findProduct("connect")!, urlFromFlag: false }

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

interface Request {
  url: string
  method: string
  form: URLSearchParams
}

/**
 * A fake Clerk and product servers: resource metadata per product, the
 * authorization server metadata, and handlers for the POST endpoints.
 */
function authServer(
  handlers: Record<string, (form: URLSearchParams) => Response> = {},
  { asIssuer = issuer, registration = false } = {},
) {
  const requests: Array<Request> = []
  const fetchFn = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input)
    const form = new URLSearchParams(
      init?.body instanceof URLSearchParams ? init.body : "",
    )
    requests.push({ url, method: init?.method ?? "GET", form })
    const product =
      /^https:\/\/(\w+)\.full\.dev\/\.well-known\/oauth-protected-resource\/mcp$/.exec(
        url,
      )
    if (product)
      return json({
        resource: `https://${product[1]}.full.dev/mcp`,
        authorization_servers: [asIssuer],
        scopes_supported: [
          "openid",
          "email",
          "offline_access",
          "user:org:read",
        ],
      })
    if (url === `${asIssuer}/.well-known/oauth-authorization-server`)
      return json({
        issuer: asIssuer,
        authorization_endpoint: `${asIssuer}/oauth/authorize`,
        token_endpoint: `${asIssuer}/oauth/token`,
        revocation_endpoint: `${asIssuer}/oauth/token/revoke`,
        device_authorization_endpoint: `${asIssuer}/oauth/device_authorization`,
        ...(registration
          ? { registration_endpoint: `${asIssuer}/oauth/register` }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
        scopes_supported: [
          "openid",
          "email",
          "offline_access",
          "user:org:read",
        ],
        code_challenge_methods_supported: ["S256"],
      })
    const path = url.startsWith(asIssuer) ? url.slice(asIssuer.length) : url
    const handler = handlers[path]
    if (handler) return handler(form)
    return new Response("not found", { status: 404 })
  })
  return { fetchFn, requests }
}

function memoryStore() {
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
  return mkdtemp(join(tmpdir(), "fulldev-")).then(
    (dir) => new CredentialStore(dir, async () => keychain),
  )
}

describe("browserLogin", () => {
  it("uses the fixed client with PKCE, a loopback port and the product as resource", async () => {
    const store = await memoryStore()
    const idToken = jwt({ email: "person@example.com" })
    const { fetchFn, requests } = authServer({
      "/oauth/token": () =>
        json({
          access_token: jwt({ org_id: "org_1", exp: 4_000_000_000 }),
          token_type: "Bearer",
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 86400,
        }),
    })
    let authorizationUrl: URL | undefined
    await browserLogin(connect, store, {
      browser: false,
      fetchFn,
      log: (line) => {
        if (!line.startsWith("https://")) return
        authorizationUrl = new URL(line)
        const redirect = new URL(
          authorizationUrl.searchParams.get("redirect_uri")!,
        )
        redirect.searchParams.set("code", "code-1")
        redirect.searchParams.set(
          "state",
          authorizationUrl.searchParams.get("state")!,
        )
        redirect.searchParams.set("iss", issuer)
        void fetch(redirect)
      },
    })
    const query = authorizationUrl!.searchParams
    expect(authorizationUrl!.origin + authorizationUrl!.pathname).toBe(
      `${issuer}/oauth/authorize`,
    )
    expect(query.get("client_id")).toBe(clientId)
    expect(query.get("resource")).toBe("https://connect.full.dev/mcp")
    expect(query.get("code_challenge_method")).toBe("S256")
    expect(query.get("scope")).toBe("openid email offline_access user:org:read")
    expect(query.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    expect(
      requests.some((request) => request.url.endsWith("/oauth/register")),
    ).toBe(false)

    const token = requests.find((request) =>
      request.url.endsWith("/oauth/token"),
    )!
    expect(token.form.get("grant_type")).toBe("authorization_code")
    expect(token.form.get("client_id")).toBe(clientId)
    expect(token.form.get("code")).toBe("code-1")
    expect(token.form.get("code_verifier")).toMatch(/^[\w.~-]{43,128}$/)
    expect(token.form.get("resource")).toBe("https://connect.full.dev/mcp")

    const saved = await store.get(connect.url)
    expect(saved).toMatchObject({
      issuer,
      email: "person@example.com",
      tokens: { refresh_token: "refresh-1" },
    })
    expect(saved.tokens).not.toHaveProperty("id_token")
    expect(await store.get(cms.url)).toEqual({})
  })

  it("registers a client only for an issuer without a fixed client id", async () => {
    const store = await memoryStore()
    const dev = "https://example.clerk.accounts.dev"
    const { fetchFn } = authServer(
      {
        "/oauth/register": () =>
          json({ client_id: "registered-1", redirect_uris: [] }, 201),
      },
      { asIssuer: dev, registration: true },
    )
    const login = browserLogin(cms, store, {
      browser: false,
      fetchFn,
      timeoutMs: 50,
      log: (line) => {
        if (line.startsWith("https://"))
          expect(new URL(line).searchParams.get("client_id")).toBe(
            "registered-1",
          )
      },
    })
    await expect(login).rejects.toThrow(/timed out/)
    expect((await store.get(cms.url)).client?.client_id).toBe("registered-1")
  })
})

describe("revokeTokens", () => {
  it("revokes the refresh token as a public client, and not the access token", async () => {
    const { fetchFn, requests } = authServer({
      "/oauth/token/revoke": () => new Response(null, { status: 200 }),
    })
    const result = await revokeTokens(
      cms,
      {
        issuer,
        tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
      },
      fetchFn,
    )
    expect(result).toEqual({ revoked: true })
    const revocations = requests.filter((request) =>
      request.url.endsWith("/oauth/token/revoke"),
    )
    expect(
      revocations.map((request) => Object.fromEntries(request.form)),
    ).toEqual([
      { token: "r", token_type_hint: "refresh_token", client_id: clientId },
    ])
  })

  it("reports a failure without throwing", async () => {
    const { fetchFn } = authServer({
      "/oauth/token/revoke": () =>
        json(
          { error: "invalid_client", error_description: "Unknown client." },
          401,
        ),
    })
    const result = await revokeTokens(
      cms,
      {
        issuer,
        tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
      },
      fetchFn,
    )
    expect(result.revoked).toBe(false)
    expect(result.error).toContain(
      "refresh_token: invalid_client: Unknown client.",
    )

    const offline = await revokeTokens(
      cms,
      {
        issuer,
        tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
      },
      async () => {
        throw new TypeError("fetch failed")
      },
    )
    expect(offline).toEqual({ revoked: false, error: "fetch failed" })
  })
})

describe("refreshing", () => {
  it("drops tokens the server no longer accepts and asks for a sign-in", async () => {
    const store = await memoryStore()
    await store.update(cms.url, () => ({
      issuer,
      tokens: { access_token: "a", token_type: "Bearer", refresh_token: "old" },
    }))
    const { fetchFn, requests } = authServer({
      "/oauth/token": () => json({ error: "invalid_grant" }, 400),
    })
    await expect(
      store.locked(() => refreshTokens(cms, store, fetchFn)),
    ).rejects.toBeInstanceOf(SignInRequiredError)
    expect((await store.get(cms.url)).tokens).toBeUndefined()
    const refresh = requests.find((request) =>
      request.url.endsWith("/oauth/token"),
    )!
    expect(Object.fromEntries(refresh.form)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old",
      client_id: clientId,
      resource: cms.url,
    })
  })

  it("uses a token another process refreshed instead of refreshing again", async () => {
    const store = await memoryStore()
    await store.update(cms.url, () => ({
      issuer,
      tokens: {
        access_token: "first",
        token_type: "Bearer",
        refresh_token: "r1",
      },
    }))
    const provider = new StoredTokenAuth(cms, store)
    expect(await provider.token()).toBe("first")
    // Another process refreshed while this request was on its way.
    await store.update(cms.url, (current) => ({
      ...current,
      tokens: {
        access_token: "second",
        token_type: "Bearer",
        refresh_token: "r2",
      },
    }))
    const fetchFn = vi.fn<FetchLike>()
    await provider.onUnauthorized({ fetchFn })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await provider.token()).toBe("second")
  })

  it("refreshes a token that is about to expire before sending it", async () => {
    const store = await memoryStore()
    await store.update(cms.url, () => ({
      issuer,
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 10 }),
        token_type: "Bearer",
        refresh_token: "r1",
      },
    }))
    const { fetchFn } = authServer({
      "/oauth/token": () =>
        json({
          access_token: "fresh",
          token_type: "Bearer",
          expires_in: 86400,
        }),
    })
    vi.stubGlobal("fetch", fetchFn)
    try {
      expect(await new StoredTokenAuth(cms, store).token()).toBe("fresh")
    } finally {
      vi.unstubAllGlobals()
    }
    expect((await store.get(cms.url)).tokens?.refresh_token).toBe("r1")
  })

  it("never starts a sign-in without tokens", async () => {
    const store = await memoryStore()
    await expect(
      new StoredTokenAuth(cms, store).token(),
    ).rejects.toBeInstanceOf(SignInRequiredError)
  })
})
