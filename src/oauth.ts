import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import {
  OAuthError,
  OAuthErrorCode,
  auth,
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  refreshAuthorization,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/client"
import type {
  AuthProvider,
  AuthorizationServerMetadata,
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
  StoredOAuthClientInformation,
} from "@modelcontextprotocol/client"

import type { CredentialStore, Credentials } from "./credentials.ts"
import { CliError, SignInRequiredError } from "./errors.ts"
import type { Target } from "./products.ts"

/**
 * The Fulldev CLI's pre-registered public OAuth client per authorization
 * server issuer. An issuer that is not listed, such as the Clerk development
 * instance behind a deploy preview, gets a dynamically registered client.
 */
export const clientIds: Record<string, string> = {
  "https://clerk.full.dev": "3Gjxf97mGc2QVnTv",
}

const trimSlash = (url: string) => url.replace(/\/+$/, "")

/** The pre-registered client for an issuer, if there is one. */
export function fixedClient(
  issuer: string | undefined,
): StoredOAuthClientInformation | undefined {
  const clientId = issuer ? clientIds[trimSlash(issuer)] : undefined
  return clientId ? { client_id: clientId, issuer } : undefined
}

/** The client to use with an issuer: the fixed one, else the registered one. */
function clientFor(issuer: string | undefined, credentials: Credentials) {
  return fixedClient(issuer) ?? credentials.client
}

/** The claims of a JWT, or {} for an opaque token. */
export function claims(token: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
    )
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** When the access token expires, in milliseconds, if known. */
export function expiresAt(credentials: Credentials): number | undefined {
  const { exp } = claims(credentials.tokens?.access_token)
  if (typeof exp === "number") return exp * 1000
  const { savedAt, tokens } = credentials
  return savedAt && tokens?.expires_in
    ? savedAt + tokens.expires_in * 1000
    : undefined
}

/** A copy of the credentials without one field. */
function without(credentials: Credentials, key: keyof Credentials) {
  const copy = { ...credentials }
  delete copy[key]
  return copy
}

const refreshEarlyMs = 60_000

function needsRefresh(credentials: Credentials, now = Date.now()) {
  const expires = expiresAt(credentials)
  return expires !== undefined && expires - refreshEarlyMs <= now
}

/** Saves tokens for a target, keeping only the email from the ID token. */
async function saveTokens(
  store: CredentialStore,
  target: Target,
  tokens: OAuthTokens,
  issuer: string,
) {
  const { id_token: idToken, ...kept } = tokens
  const { email } = claims(idToken)
  await store.update(target.url, (current) => ({
    ...current,
    issuer,
    tokens: kept,
    email: typeof email === "string" ? email : current.email,
    savedAt: Date.now(),
  }))
}

/** Metadata fields the SDK's type leaves out (RFC 8414, RFC 8628). */
type ServerMetadata = AuthorizationServerMetadata & {
  revocation_endpoint?: string
}

interface Discovery {
  authorizationServerUrl: string | URL
  metadata: ServerMetadata
  issuer: string
  /** The product's MCP URL as the resource server names it. */
  resource: string
  resourceMetadata: OAuthProtectedResourceMetadata
}

/** Finds the target's authorization server and checks its resource. */
export async function discover(
  target: Target,
  fetchFn?: FetchLike,
): Promise<Discovery> {
  const info = await discoverOAuthServerInfo(target.url, { fetchFn })
  const metadata = info.authorizationServerMetadata
  const resource = info.resourceMetadata?.resource
  if (!metadata || !info.resourceMetadata || !resource)
    throw new CliError(
      "DISCOVERY_FAILED",
      `${target.url} does not publish OAuth metadata for its MCP server.`,
    )
  if (
    !checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(target.url),
      configuredResource: resource,
    })
  )
    throw new CliError(
      "RESOURCE_MISMATCH",
      `The server names its resource ${resource}, which does not match ${target.url}.`,
    )
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    issuer: metadata.issuer,
    resource,
    resourceMetadata: info.resourceMetadata,
  }
}

/** The scopes the resource asks for, plus offline_access for a refresh token. */
export function scopeFor({ resourceMetadata, metadata }: Discovery) {
  const scopes = new Set(resourceMetadata.scopes_supported ?? [])
  if (metadata.scopes_supported?.includes("offline_access"))
    scopes.add("offline_access")
  return [...scopes].join(" ")
}

const callbackPath = "/callback"

/** The redirect URIs a dynamically registered client was registered with. */
function redirectUris(client: StoredOAuthClientInformation | undefined) {
  return client && "redirect_uris" in client ? client.redirect_uris : []
}

/**
 * The SDK's view of one browser sign-in: the fixed client, or a registered
 * one for an unknown issuer, with PKCE S256 and a loopback redirect.
 */
class BrowserLoginProvider implements OAuthClientProvider {
  private verifier = ""
  private discovery: OAuthDiscoveryState | undefined

  constructor(
    private readonly store: CredentialStore,
    private readonly target: Target,
    readonly redirectUrl: string,
    private readonly loginState: string,
    private readonly onAuthorizationUrl: (url: URL) => void,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Fulldev CLI",
      client_uri: "https://github.com/fulldotdev/cli",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  state() {
    return this.loginState
  }

  async clientInformation(ctx?: OAuthClientInformationContext) {
    const fixed = fixedClient(ctx?.issuer)
    if (fixed) return fixed
    const { client } = await this.store.get(this.target.url)
    // A client registered for another loopback port cannot receive this code.
    return redirectUris(client).includes(this.redirectUrl) ? client : undefined
  }

  async saveClientInformation(
    client: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ) {
    if (fixedClient(ctx?.issuer ?? client.issuer)) return
    await this.store.update(this.target.url, (current) => ({
      ...current,
      client,
    }))
  }

  /** A sign-in always asks again, so it never reuses stored tokens. */
  tokens() {
    return undefined
  }

  async saveTokens(tokens: OAuthTokens, ctx?: OAuthClientInformationContext) {
    const issuer = ctx?.issuer ?? (tokens as { issuer?: string }).issuer
    await saveTokens(this.store, this.target, tokens, issuer ?? "")
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.onAuthorizationUrl(authorizationUrl)
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }

  codeVerifier() {
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state
  }

  discoveryState() {
    return this.discovery
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    if (scope === "verifier") this.verifier = ""
    if (scope === "discovery" || scope === "all") this.discovery = undefined
    if (scope === "client" || scope === "all")
      await this.store.update(this.target.url, (current) =>
        without(current, "client"),
      )
  }
}

interface Callback {
  port: number
  wait: (timeoutMs: number) => Promise<URLSearchParams>
  close: () => void
}

// The Fulldev logo tile from full.dev's favicon: the white mark on blue.
const markPaths = [
  "M9.955 0.313C5.246 1.263 1.658 3.599 0.434 6.534C0.19 7.118 0.046 7.725 0.009 8.348C-0.003 8.552 0.11 8.743 0.294 8.83C0.479 8.917 0.698 8.883 0.848 8.744C1.78 7.881 4.717 5.41 10.404 4.48C11.847 4.244 12.134 3.917 11.95 2.206C11.766 0.495 11.389 0.024 9.955 0.313Z",
  "M9.88 6.991C5.285 7.935 2.974 9.921 2.178 10.698C0.632 12.206 0 13.835 0 15.33C0 19.489 4.773 22.976 11.193 23.899C11.753 23.979 11.894 23.839 11.976 23.179C12.057 22.518 11.949 22.386 11.392 22.29C6.958 21.533 3.726 19.389 3.58 16.84C3.535 16.049 3.76 14.692 5.536 13.328C6.736 12.406 8.42 11.671 10.4 11.223C11.851 10.893 12.152 10.624 11.938 8.886C11.725 7.148 11.338 6.691 9.88 6.991Z",
  "M11.193 17.238C5.987 16.49 3.213 14.334 2.104 13.229L4.381 12.195C5.161 13.214 7.18 14.91 11.392 15.63C11.949 15.725 12.057 15.858 11.976 16.518C11.894 17.179 11.753 17.319 11.193 17.238Z",
]
const tile = `<svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7.68" fill="#0737ff"/><g transform="translate(10.72 6.8) scale(0.8)" fill="#ffffff">${markPaths.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`

// The page the browser shows after sign-in, in the Fulldev colours.
const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fulldev CLI</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f7f4;color:#2b2d33;font:16px/1.6 Geist,system-ui,sans-serif"><main style="max-width:28rem;padding:2rem;text-align:center">${tile}<p>${message}</p></main></body>`

/** Listens on 127.0.0.1 for the authorization server's redirect (RFC 8252). */
async function listenForCallback(preferredPort?: number): Promise<Callback> {
  let receive: (params: URLSearchParams) => void = () => {}
  const received = new Promise<URLSearchParams>((resolve) => {
    receive = resolve
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== callbackPath) {
      response.writeHead(404).end()
      return
    }
    const failed = url.searchParams.has("error")
    response
      .writeHead(failed ? 400 : 200, { "content-type": "text/html" })
      .end(
        page(
          failed
            ? "Sign-in did not complete. You can close this tab and check the terminal."
            : "Sign-in received. You can close this tab and return to the terminal.",
        ),
        () => receive(url.searchParams),
      )
  })
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
  try {
    await listen(preferredPort ?? 0)
  } catch (error) {
    if (preferredPort === undefined) throw error
    await listen(0)
  }
  return {
    port: (server.address() as AddressInfo).port,
    wait: async (timeoutMs) => {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CliError(
                "SIGN_IN_TIMEOUT",
                `Sign-in timed out after ${Math.round(timeoutMs / 60_000)} minutes.`,
              ),
            ),
          timeoutMs,
        )
      })
      try {
        return await Promise.race([received, timeout])
      } finally {
        clearTimeout(timer)
      }
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/** Opens a URL in the system browser; the URL is printed as well. */
function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
        : ["xdg-open", [url]]
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // The printed link still works.
  }
}

export interface BrowserLoginOptions {
  browser: boolean
  log: (line: string) => void
  timeoutMs?: number
  fetchFn?: FetchLike
}

/**
 * Signs in with the authorization code flow and PKCE S256, the system
 * browser and a loopback redirect on an ephemeral port, asking for the
 * product's MCP URL as the resource.
 */
export async function browserLogin(
  target: Target,
  store: CredentialStore,
  { browser, log, timeoutMs = 5 * 60_000, fetchFn }: BrowserLoginOptions,
) {
  // A registered client (unknown issuer) keeps the port it was registered with.
  const registered = redirectUris((await store.get(target.url)).client)[0]
  const callback = await listenForCallback(
    registered ? Number(new URL(registered).port) || undefined : undefined,
  )
  try {
    const state = randomBytes(16).toString("base64url")
    const provider = new BrowserLoginProvider(
      store,
      target,
      `http://127.0.0.1:${callback.port}${callbackPath}`,
      state,
      (url) => {
        log(
          `Sign in to ${target.title} in your browser. If it does not open, open:`,
        )
        log(url.href)
        if (browser) openBrowser(url.href)
      },
    )
    const started = await auth(provider, {
      serverUrl: target.url,
      forceReauthorization: true,
      ...(fetchFn ? { fetchFn } : {}),
    })
    if (started === "AUTHORIZED") return
    const params = await callback.wait(timeoutMs)
    if (params.get("state") !== state)
      throw new CliError(
        "SIGN_IN_FAILED",
        "Sign-in failed: the response did not match this sign-in.",
      )
    const error = params.get("error")
    if (error)
      throw new CliError(
        "SIGN_IN_FAILED",
        `Sign-in failed: ${[error, params.get("error_description")].filter(Boolean).join(": ")}`,
        undefined,
        { oauthError: error },
      )
    const code = params.get("code")
    if (!code)
      throw new CliError(
        "SIGN_IN_FAILED",
        "Sign-in failed: no authorization code.",
      )
    await auth(provider, {
      serverUrl: target.url,
      authorizationCode: code,
      iss: params.get("iss") ?? undefined,
      ...(fetchFn ? { fetchFn } : {}),
    })
  } finally {
    callback.close()
  }
}

const formHeaders = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * Refreshes the target's tokens. Call it while holding the store's lock.
 * A refresh token the server no longer accepts is dropped, and the command
 * then needs a new sign-in.
 */
export async function refreshTokens(
  target: Target,
  store: CredentialStore,
  fetchFn?: FetchLike,
) {
  const credentials = await store.get(target.url)
  const refreshToken = credentials.tokens?.refresh_token
  if (!refreshToken) throw new SignInRequiredError(target)
  const discovery = await discover(target, fetchFn)
  const client = clientFor(discovery.issuer, credentials)
  if (
    !client ||
    (credentials.issuer && credentials.issuer !== discovery.issuer)
  )
    throw new SignInRequiredError(target)
  let tokens: OAuthTokens
  try {
    tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.metadata,
      clientInformation: client,
      refreshToken,
      resource: new URL(discovery.resource),
      ...(fetchFn ? { fetchFn } : {}),
    })
  } catch (error) {
    if (
      error instanceof OAuthError &&
      (error.code === OAuthErrorCode.InvalidGrant ||
        error.code === OAuthErrorCode.InvalidClient ||
        error.code === OAuthErrorCode.UnauthorizedClient)
    ) {
      await store.update(target.url, (current) => without(current, "tokens"))
      throw new SignInRequiredError(target)
    }
    throw error
  }
  await saveTokens(store, target, tokens, discovery.issuer)
}

export interface RevokeResult {
  revoked: boolean
  error?: string
}

/**
 * Revokes the refresh token (RFC 7009), sending the client_id as a public
 * client. Never throws: the result says what failed.
 */
export async function revokeTokens(
  target: Target,
  credentials: Credentials,
  fetchFn: FetchLike = fetch,
): Promise<RevokeResult> {
  const { tokens } = credentials
  if (!tokens) return { revoked: true }
  try {
    const metadata: ServerMetadata | undefined = credentials.issuer
      ? await discoverAuthorizationServerMetadata(credentials.issuer, {
          fetchFn,
        })
      : (await discover(target, fetchFn)).metadata
    const endpoint = metadata?.revocation_endpoint
    if (!endpoint)
      return {
        revoked: false,
        error: "The authorization server has no revocation endpoint.",
      }
    // Tokens are revoked with the client they were issued to, which for a
    // sign-in from fulldev 0.1.0 is its dynamically registered client.
    const client = credentials.client ?? fixedClient(metadata.issuer)
    if (!client)
      return { revoked: false, error: "No OAuth client to revoke with." }
    const failures: Array<string> = []
    // Only the refresh token: Clerk's access tokens are JWTs that cannot be
    // revoked and expire within a day.
    for (const [token, hint] of [
      [tokens.refresh_token, "refresh_token"],
    ] as const) {
      if (!token) continue
      const body = new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: client.client_id,
      })
      if (client.client_secret) body.set("client_secret", client.client_secret)
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: formHeaders,
        body,
      })
      if (!response.ok) {
        const answer = await readJson(response)
        failures.push(
          `${hint}: ${[text(answer.error) ?? `HTTP ${response.status}`, text(answer.error_description)].filter(Boolean).join(": ")}`,
        )
      }
    }
    return failures.length
      ? {
          revoked: false,
          error: `Revocation failed for ${failures.join("; ")}`,
        }
      : { revoked: true }
  } catch (error) {
    return { revoked: false, error: (error as Error).message }
  }
}

/**
 * Gives the MCP transport the stored access token of one product, refreshing
 * it when it is about to expire or the server answers 401. Refreshes happen
 * under the store's lock, and a token another process refreshed meanwhile is
 * used instead of refreshing again. It never starts a sign-in.
 */
export class StoredTokenAuth implements AuthProvider {
  private sent: string | undefined

  constructor(
    private readonly target: Target,
    private readonly store: CredentialStore,
  ) {}

  private async refreshUnless(
    changed: (current: Credentials) => boolean,
    fetchFn?: FetchLike,
  ) {
    await this.store.locked(async () => {
      const current = await this.store.get(this.target.url)
      if (!changed(current))
        await refreshTokens(this.target, this.store, fetchFn)
    })
  }

  async token() {
    let credentials = await this.store.get(this.target.url)
    if (!credentials.tokens) throw new SignInRequiredError(this.target)
    if (needsRefresh(credentials)) {
      const stale = credentials.tokens.access_token
      await this.refreshUnless(
        (current) =>
          current.tokens?.access_token !== stale && !needsRefresh(current),
      )
      credentials = await this.store.get(this.target.url)
    }
    this.sent = credentials.tokens?.access_token
    return this.sent
  }

  async onUnauthorized(ctx: { fetchFn: FetchLike }) {
    await this.refreshUnless(
      (current) =>
        current.tokens?.access_token !== undefined &&
        current.tokens.access_token !== this.sent,
      ctx.fetchFn,
    )
  }
}
