import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { auth } from "@modelcontextprotocol/client"
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"

import type { CredentialStore } from "./credentials.ts"

/** Thrown when a command needs a sign-in that it may not start itself. */
export class LoginRequiredError extends Error {
  constructor(serverUrl: string) {
    super(`Not signed in to ${serverUrl}. Run: fulldev login`)
    this.name = "LoginRequiredError"
  }
}

export function isLoginRequired(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof LoginRequiredError) return true
  return false
}

const callbackPath = "/callback"

/** The redirect URIs a dynamically registered client was registered with. */
function redirectUris(client: StoredOAuthClientInformation | undefined) {
  return client && "redirect_uris" in client ? client.redirect_uris : []
}

interface LoginContext {
  redirectUrl: string
  state: string
  onAuthorizationUrl: (url: URL) => void | Promise<void>
}

/**
 * Keeps the OAuth client and tokens in the credentials file. Without a login
 * context it only uses and refreshes what is stored: it never registers a
 * client or starts a sign-in, so a normal command cannot hang on a browser.
 */
export class CliOAuthProvider implements OAuthClientProvider {
  private verifier = ""
  private discovery: OAuthDiscoveryState | undefined

  constructor(
    private readonly store: CredentialStore,
    private readonly login?: LoginContext,
  ) {}

  get redirectUrl() {
    return this.login?.redirectUrl ?? `http://127.0.0.1${callbackPath}`
  }

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
    return this.login?.state ?? randomBytes(16).toString("base64url")
  }

  async clientInformation() {
    const { client } = await this.store.get()
    if (!this.login) {
      if (!client) throw new LoginRequiredError(this.store.serverUrl)
      return client
    }
    // A client registered for another loopback port cannot receive this code.
    return redirectUris(client).includes(this.login.redirectUrl)
      ? client
      : undefined
  }

  async saveClientInformation(client: StoredOAuthClientInformation) {
    await this.store.update((current) => ({ ...current, client }))
  }

  async tokens() {
    return (await this.store.get()).tokens
  }

  async saveTokens(tokens: StoredOAuthTokens) {
    await this.store.update((current) => ({
      ...current,
      tokens,
      savedAt: Date.now(),
    }))
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    if (!this.login) throw new LoginRequiredError(this.store.serverUrl)
    await this.login.onAuthorizationUrl(authorizationUrl)
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
    if (scope === "all" || scope === "client" || scope === "tokens")
      await this.store.update(({ client, tokens }) => ({
        ...(scope === "tokens" && client ? { client } : {}),
        ...(scope === "client" && tokens ? { tokens } : {}),
      }))
  }
}

interface Callback {
  port: number
  wait: (timeoutMs: number) => Promise<URLSearchParams>
  close: () => void
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Fulldev CLI</title><body style="font-family:system-ui;padding:3rem"><p>${message}</p></body>`

/** Listens on 127.0.0.1 for the authorization server's redirect. */
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
      )
    receive(url.searchParams)
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
              new Error(
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
export function openBrowser(url: string) {
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

export interface LoginOptions {
  browser: boolean
  log: (line: string) => void
  timeoutMs?: number
}

/**
 * Signs in with the authorization code flow and PKCE: discovery from the MCP
 * URL, dynamic client registration when needed, the system browser and a
 * loopback redirect. The registered client and its port are reused.
 */
export async function login(
  serverUrl: string,
  store: CredentialStore,
  { browser, log, timeoutMs = 5 * 60_000 }: LoginOptions,
) {
  const { client } = await store.get()
  const registered = redirectUris(client)[0]
  const callback = await listenForCallback(
    registered ? Number(new URL(registered).port) || undefined : undefined,
  )
  try {
    const state = randomBytes(16).toString("base64url")
    const provider = new CliOAuthProvider(store, {
      redirectUrl: `http://127.0.0.1:${callback.port}${callbackPath}`,
      state,
      onAuthorizationUrl: (url) => {
        log(`Sign in to Fulldev in your browser. If it does not open, open:`)
        log(url.href)
        if (browser) openBrowser(url.href)
      },
    })
    const started = await auth(provider, {
      serverUrl,
      forceReauthorization: true,
    })
    if (started === "AUTHORIZED") return
    const params = await callback.wait(timeoutMs)
    if (params.get("state") !== state)
      throw new Error("Sign-in failed: the response did not match this login.")
    const error = params.get("error")
    if (error)
      throw new Error(
        `Sign-in failed: ${[error, params.get("error_description")].filter(Boolean).join(": ")}`,
      )
    const code = params.get("code")
    if (!code) throw new Error("Sign-in failed: no authorization code.")
    await auth(provider, {
      serverUrl,
      authorizationCode: code,
      iss: params.get("iss") ?? undefined,
    })
  } finally {
    callback.close()
  }
}
