import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import type { FetchLike } from "@modelcontextprotocol/client"
import { describe, expect, it, vi } from "vite-plus/test"

import { CredentialStore } from "./credentials.ts"
import type { Keychain } from "./credentials.ts"
import { SignInRequiredError } from "./errors.ts"
import {
  StoredTokenAuth,
  browserLogin,
  clientMetadataUrl,
  refreshTokens,
  revokeTokens,
} from "./oauth.ts"
import { server } from "./apps.ts"
import type { Target } from "./apps.ts"

const issuer = "https://app.full.dev/api/auth"
const client = { client_id: clientMetadataUrl, issuer }
const scopes = ["openid", "profile", "email", "offline_access"]
// As the MCP server advertises them: `openid` is the authorization
// server's own scope (apps/app/server/auth/access.ts).
const resourceScopes = ["profile", "email", "offline_access"]
const fulldev: Target = { ...server, urlFromFlag: false }
// Another server, such as a test site's, with a sign-in of its own.
const other: Target = {
  ...server,
  url: "https://other.full.dev/mcp",
  urlFromFlag: false,
}

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
 * A fake Better Auth server and MCP servers: resource metadata per
 * server, the authorization server metadata (RFC 8414, at the well-known
 * path before the issuer's path), and handlers for the POST endpoints.
 */
function authServer(
  handlers: Record<string, (form: URLSearchParams) => Response> = {},
  { asIssuer = issuer, metadataDocuments = true, registration = false } = {},
) {
  const requests: Array<Request> = []
  const { origin, pathname } = new URL(asIssuer)
  const fetchFn = vi.fn<FetchLike>(async (input, init) => {
    const url = String(input)
    const form = new URLSearchParams(
      init?.body instanceof URLSearchParams ? init.body : "",
    )
    requests.push({ url, method: init?.method ?? "GET", form })
    const app =
      /^https:\/\/(\w+)\.full\.dev\/\.well-known\/oauth-protected-resource\/mcp$/.exec(
        url,
      )
    if (app)
      return json({
        resource: `https://${app[1]}.full.dev/mcp`,
        authorization_servers: [asIssuer],
        scopes_supported: resourceScopes,
        bearer_methods_supported: ["header"],
      })
    if (url === `${origin}/.well-known/oauth-authorization-server${pathname}`)
      return json({
        issuer: asIssuer,
        authorization_endpoint: `${asIssuer}/oauth2/authorize`,
        token_endpoint: `${asIssuer}/oauth2/token`,
        revocation_endpoint: `${asIssuer}/oauth2/revoke`,
        ...(registration
          ? { registration_endpoint: `${asIssuer}/oauth2/register` }
          : {}),
        ...(metadataDocuments
          ? { client_id_metadata_document_supported: true }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_basic",
          "client_secret_post",
          "private_key_jwt",
        ],
        scopes_supported: scopes,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
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
  it("identifies itself with its metadata document, with PKCE, a loopback port and the app as resource", async () => {
    const store = await memoryStore()
    const idToken = jwt({ email: "person@example.com" })
    const { fetchFn, requests } = authServer({
      "/oauth2/token": () =>
        json({
          access_token: jwt({ org_id: "org_1", exp: 4_000_000_000 }),
          token_type: "Bearer",
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 3600,
        }),
    })
    let authorizationUrl: URL | undefined
    await browserLogin(other, store, {
      browser: false,
      fetchFn,
      input: new PassThrough(),
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
      `${issuer}/oauth2/authorize`,
    )
    expect(query.get("client_id")).toBe(clientMetadataUrl)
    expect(query.get("resource")).toBe("https://other.full.dev/mcp")
    expect(query.get("code_challenge_method")).toBe("S256")
    // openid too, though the resource does not list it, for the ID token.
    expect(query.get("scope")).toBe("openid profile email offline_access")
    expect(query.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    )
    expect(
      requests.some((request) => request.url.endsWith("/oauth2/register")),
    ).toBe(false)

    const token = requests.find((request) =>
      request.url.endsWith("/oauth2/token"),
    )!
    expect(token.form.get("grant_type")).toBe("authorization_code")
    expect(token.form.get("client_id")).toBe(clientMetadataUrl)
    expect(token.form.get("code")).toBe("code-1")
    expect(token.form.get("code_verifier")).toMatch(/^[\w.~-]{43,128}$/)
    expect(token.form.get("resource")).toBe("https://other.full.dev/mcp")
    expect(token.form.get("redirect_uri")).toBe(query.get("redirect_uri"))

    const saved = await store.get(other.url)
    expect(saved).toMatchObject({
      issuer,
      client,
      email: "person@example.com",
      tokens: { refresh_token: "refresh-1" },
    })
    expect(saved.tokens).not.toHaveProperty("id_token")
    expect(await store.get(fulldev.url)).toEqual({})
  })

  it("never keeps the previous person's email on a new sign-in", async () => {
    const store = await memoryStore()
    await store.update(fulldev.url, () => ({
      issuer,
      client,
      email: "previous@example.com",
      tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
    }))
    const signIn = async (idToken?: string) => {
      const { fetchFn } = authServer({
        "/oauth2/token": () =>
          json({
            access_token: "new",
            token_type: "Bearer",
            refresh_token: "refresh-new",
            ...(idToken ? { id_token: idToken } : {}),
          }),
      })
      await browserLogin(fulldev, store, {
        browser: false,
        fetchFn,
        input: new PassThrough(),
        log: (line) => {
          if (!line.startsWith("https://")) return
          const authorization = new URL(line)
          const redirect = new URL(
            authorization.searchParams.get("redirect_uri")!,
          )
          redirect.searchParams.set("code", "code-1")
          redirect.searchParams.set(
            "state",
            authorization.searchParams.get("state")!,
          )
          redirect.searchParams.set("iss", issuer)
          void fetch(redirect)
        },
      })
    }
    await signIn(jwt({ email: "next@example.com" }))
    expect((await store.get(fulldev.url)).email).toBe("next@example.com")
    // Without an ID token the email is unknown, not the one before.
    await signIn()
    expect(await store.get(fulldev.url)).not.toHaveProperty("email")

    // A refresh, which has no ID token, keeps the sign-in's email.
    await store.update(fulldev.url, (current) => ({
      ...current,
      email: "next@example.com",
    }))
    const { fetchFn } = authServer({
      "/oauth2/token": () =>
        json({ access_token: "refreshed", token_type: "Bearer" }),
    })
    await store.locked(() => refreshTokens(fulldev, store, fetchFn))
    expect(await store.get(fulldev.url)).toMatchObject({
      email: "next@example.com",
      tokens: { access_token: "refreshed" },
    })
  })

  it("takes the address after sign-in pasted into the terminal, for a browser on another computer", async () => {
    const store = await memoryStore()
    const { fetchFn, requests } = authServer({
      "/oauth2/token": () =>
        json({
          access_token: jwt({ org_id: "org_1", exp: 4_000_000_000 }),
          token_type: "Bearer",
          refresh_token: "refresh-1",
          expires_in: 3600,
        }),
    })
    const input = new PassThrough()
    const logged: Array<string> = []
    await browserLogin(fulldev, store, {
      browser: false,
      fetchFn,
      input,
      log: (line) => {
        logged.push(line)
        if (!line.startsWith("https://")) return
        const authorization = new URL(line)
        // The browser on the other computer cannot load this page, so the
        // person copies its address.
        const redirect = new URL(
          authorization.searchParams.get("redirect_uri")!,
        )
        redirect.searchParams.set("code", "code-1")
        redirect.searchParams.set(
          "state",
          authorization.searchParams.get("state")!,
        )
        redirect.searchParams.set("iss", issuer)
        input.write("code-1\n")
        input.write(`  ${redirect.href}  \n`)
      },
    })
    expect(logged.join("\n")).toMatch(/paste it here/)
    expect(logged.join("\n")).toMatch(/That is not the address/)
    const token = requests.find((request) =>
      request.url.endsWith("/oauth2/token"),
    )!
    expect(token.form.get("code")).toBe("code-1")
    expect(await store.get(fulldev.url)).toMatchObject({
      issuer,
      client,
      tokens: { refresh_token: "refresh-1" },
    })
  })

  it("refuses a pasted address of another sign-in", async () => {
    const store = await memoryStore()
    const { fetchFn, requests } = authServer()
    const input = new PassThrough()
    const login = browserLogin(fulldev, store, {
      browser: false,
      fetchFn,
      input,
      log: (line) => {
        if (line.startsWith("https://"))
          input.write(
            "http://127.0.0.1:1234/callback?code=code-1&state=another\n",
          )
      },
    })
    await expect(login).rejects.toMatchObject({ code: "SIGN_IN_FAILED" })
    expect(
      requests.some((request) => request.url.endsWith("/oauth2/token")),
    ).toBe(false)
    expect(await store.get(fulldev.url)).toEqual({})
  })

  it("fails clearly with a server that does not support metadata documents, and registers no client", async () => {
    const store = await memoryStore()
    const preview = "https://deploy-preview-12--fulldev.netlify.app/api/auth"
    const { fetchFn, requests } = authServer(
      {
        "/oauth2/register": () =>
          json({ client_id: "registered-1", redirect_uris: [] }, 201),
      },
      { asIssuer: preview, metadataDocuments: false, registration: true },
    )
    const log = vi.fn()
    await expect(
      browserLogin(fulldev, store, {
        browser: false,
        fetchFn,
        input: new PassThrough(),
        log,
      }),
    ).rejects.toMatchObject({
      code: "CLIENT_METADATA_UNSUPPORTED",
      message: expect.stringContaining(preview),
    })
    expect(log).not.toHaveBeenCalled()
    expect(
      requests.some((request) => request.url.endsWith("/oauth2/register")),
    ).toBe(false)
    expect(await store.get(fulldev.url)).toEqual({})
  })
})

describe("revokeTokens", () => {
  it("revokes the refresh token as a public client, and not the access token", async () => {
    const { fetchFn, requests } = authServer({
      "/oauth2/revoke": () => new Response(null, { status: 200 }),
    })
    const result = await revokeTokens(
      fulldev,
      {
        issuer,
        client,
        tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
      },
      fetchFn,
    )
    expect(result).toEqual({ revoked: true })
    const revocations = requests.filter((request) =>
      request.url.endsWith("/oauth2/revoke"),
    )
    expect(
      revocations.map((request) => Object.fromEntries(request.form)),
    ).toEqual([
      {
        token: "r",
        token_type_hint: "refresh_token",
        client_id: clientMetadataUrl,
      },
    ])
  })

  it("reports a failure without throwing", async () => {
    const { fetchFn } = authServer({
      "/oauth2/revoke": () =>
        json(
          { error: "invalid_client", error_description: "Unknown client." },
          401,
        ),
    })
    const credentials = {
      issuer,
      client,
      tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
    }
    const result = await revokeTokens(fulldev, credentials, fetchFn)
    expect(result.revoked).toBe(false)
    expect(result.error).toContain(
      "refresh_token: invalid_client: Unknown client.",
    )

    const offline = await revokeTokens(fulldev, credentials, async () => {
      throw new TypeError("fetch failed")
    })
    expect(offline).toEqual({ revoked: false, error: "fetch failed" })
  })

  it("cannot revoke a sign-in without a client, from an earlier fulldev", async () => {
    const fetchFn = vi.fn<FetchLike>()
    const result = await revokeTokens(
      fulldev,
      {
        issuer: "https://clerk.full.dev",
        tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
      },
      fetchFn,
    )
    expect(result).toEqual({
      revoked: false,
      error: expect.stringContaining("earlier version"),
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe("refreshing", () => {
  it("drops tokens the server no longer accepts and asks for a sign-in", async () => {
    const store = await memoryStore()
    await store.update(fulldev.url, () => ({
      issuer,
      client,
      tokens: { access_token: "a", token_type: "Bearer", refresh_token: "old" },
    }))
    const { fetchFn, requests } = authServer({
      "/oauth2/token": () => json({ error: "invalid_grant" }, 400),
    })
    await expect(
      store.locked(() => refreshTokens(fulldev, store, fetchFn)),
    ).rejects.toBeInstanceOf(SignInRequiredError)
    expect((await store.get(fulldev.url)).tokens).toBeUndefined()
    const refresh = requests.find((request) =>
      request.url.endsWith("/oauth2/token"),
    )!
    expect(Object.fromEntries(refresh.form)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old",
      client_id: clientMetadataUrl,
      resource: fulldev.url,
    })
  })

  it("asks for a new sign-in when the app moved to another authorization server", async () => {
    const store = await memoryStore()
    const clerk = "https://clerk.full.dev"
    await store.update(fulldev.url, () => ({
      issuer: clerk,
      client: { client_id: "registered-1", issuer: clerk },
      tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
    }))
    const { fetchFn, requests } = authServer()
    await expect(
      store.locked(() => refreshTokens(fulldev, store, fetchFn)),
    ).rejects.toBeInstanceOf(SignInRequiredError)
    expect(
      requests.some((request) => request.url.endsWith("/oauth2/token")),
    ).toBe(false)
  })

  it("uses a token another process refreshed instead of refreshing again", async () => {
    const store = await memoryStore()
    await store.update(fulldev.url, () => ({
      issuer,
      client,
      tokens: {
        access_token: "first",
        token_type: "Bearer",
        refresh_token: "r1",
      },
    }))
    const provider = new StoredTokenAuth(fulldev, store)
    expect(await provider.token()).toBe("first")
    // Another process refreshed while this request was on its way.
    await store.update(fulldev.url, (current) => ({
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
    await store.update(fulldev.url, () => ({
      issuer,
      client,
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 10 }),
        token_type: "Bearer",
        refresh_token: "r1",
      },
    }))
    const { fetchFn } = authServer({
      "/oauth2/token": () =>
        json({
          access_token: "fresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
    })
    vi.stubGlobal("fetch", fetchFn)
    try {
      expect(await new StoredTokenAuth(fulldev, store).token()).toBe("fresh")
    } finally {
      vi.unstubAllGlobals()
    }
    expect((await store.get(fulldev.url)).tokens?.refresh_token).toBe("r1")
  })

  it("never starts a sign-in without tokens", async () => {
    const store = await memoryStore()
    await expect(
      new StoredTokenAuth(fulldev, store).token(),
    ).rejects.toBeInstanceOf(SignInRequiredError)
  })
})
