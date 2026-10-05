#!/usr/bin/env node
import { Client, ProtocolError, SdkError, StreamableHTTPClientTransport, UnauthorizedError, auth } from "@modelcontextprotocol/client";
import { parseArgs } from "node:util";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
//#region package.json
var version = "0.1.0";
//#endregion
//#region src/args.ts
const defaultUrl = "https://cms.full.dev/mcp";
/** A mistake in how the CLI was called. */
var UsageError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
};
const expected = {
	login: [
		0,
		0,
		"fulldev login"
	],
	logout: [
		0,
		0,
		"fulldev logout"
	],
	status: [
		0,
		0,
		"fulldev status"
	],
	instructions: [
		0,
		0,
		"fulldev instructions"
	],
	tools: [
		0,
		1,
		"fulldev tools [name]"
	],
	call: [
		1,
		2,
		"fulldev call <tool> [json | -] [--file <path>]"
	],
	form: [
		3,
		3,
		"fulldev form wait <branchId> <formId> [--timeout <minutes>]"
	],
	help: [
		0,
		0,
		"fulldev help"
	]
};
function parseCommandLine(argv, env = process.env) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			allowNegative: true,
			strict: true,
			options: {
				url: { type: "string" },
				file: {
					type: "string",
					short: "f"
				},
				timeout: { type: "string" },
				login: {
					type: "boolean",
					default: true
				},
				browser: {
					type: "boolean",
					default: true
				},
				help: {
					type: "boolean",
					short: "h",
					default: false
				},
				version: {
					type: "boolean",
					short: "v",
					default: false
				}
			}
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const { values, positionals } = parsed;
	const [command, ...args] = positionals;
	const url = values.url ?? env.FULLDEV_URL ?? "https://cms.full.dev/mcp";
	let parsedUrl;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new UsageError(`Not a valid server URL: ${url}`);
	}
	if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new UsageError(`The server URL must use https: ${url}`);
	const timeoutMinutes = values.timeout === void 0 ? 30 : Number(values.timeout);
	if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new UsageError(`--timeout must be a number of minutes above 0.`);
	const result = {
		command,
		args,
		url: parsedUrl.href,
		file: values.file,
		timeoutMinutes,
		login: values.login,
		browser: values.browser,
		help: values.help,
		version: values.version
	};
	if (!command || result.help || result.version) return result;
	const rule = expected[command];
	if (!rule) throw new UsageError(`Unknown command: ${command}`);
	const [min, max, usage] = rule;
	if (command === "form" && args[0] !== "wait") throw new UsageError(`Usage: ${usage}`);
	if (args.length < min || args.length > max) throw new UsageError(`Usage: ${usage}`);
	if (values.file !== void 0 && command !== "call") throw new UsageError("--file only works with fulldev call.");
	if (values.timeout !== void 0 && command !== "form") throw new UsageError("--timeout only works with fulldev form wait.");
	return result;
}
const help = `Fulldev CLI: edit your website through the Fulldev CMS.

Usage:
  fulldev login                     Sign in (opens your browser)
  fulldev logout                    Forget the saved sign-in for this server
  fulldev status                    Show who is signed in and whether it works
  fulldev instructions              Print the server's instructions for agents
  fulldev tools [name]              List tools, or show one tool's input schema
  fulldev call <tool> [json | -]    Call a tool with a JSON object (- reads stdin)
  fulldev form wait <branchId> <formId>
                                    Wait until the person sends a form

Options:
  --url <mcp url>      Server to use (default ${defaultUrl}, or FULLDEV_URL)
  -f, --file <path>    Read the tool's JSON input from a file (call)
  --timeout <minutes>  How long form wait waits (default 30)
  --no-login           Fail instead of opening a sign-in when not signed in
  --no-browser         Print the sign-in link without opening a browser
  -h, --help           Show this help
  -v, --version        Show the version

Results are JSON on stdout; hints and errors go to stderr.
Exit codes: 0 done, 1 error, 2 form wait timed out, 3 sign-in needed.
`;
//#endregion
//#region src/credentials.ts
function credentialsPath(env = process.env) {
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "fulldev", "credentials.json");
}
async function readAll(path) {
	try {
		const data = JSON.parse(await readFile(path, "utf8"));
		if (data && typeof data === "object" && "servers" in data && data.servers && typeof data.servers === "object") return data;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return { servers: {} };
}
/** Writes the whole file readable only by this user, replacing it atomically. */
async function writeAll(path, data) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 384 });
	await chmod(temporary, 384);
	await rename(temporary, path);
}
/** Reads and writes the credentials of one server, keyed by its MCP URL. */
var CredentialStore = class {
	serverUrl;
	path;
	constructor(serverUrl, path = credentialsPath()) {
		this.serverUrl = serverUrl;
		this.path = path;
	}
	async get() {
		return (await readAll(this.path)).servers[this.serverUrl] ?? {};
	}
	async update(change) {
		const data = await readAll(this.path);
		const next = change(data.servers[this.serverUrl] ?? {});
		if (Object.keys(next).length) data.servers[this.serverUrl] = next;
		else delete data.servers[this.serverUrl];
		if (Object.keys(data.servers).length) await writeAll(this.path, data);
		else await rm(this.path, { force: true });
	}
};
//#endregion
//#region src/oauth.ts
/** Thrown when a command needs a sign-in that it may not start itself. */
var LoginRequiredError = class extends Error {
	constructor(serverUrl) {
		super(`Not signed in to ${serverUrl}. Run: fulldev login`);
		this.name = "LoginRequiredError";
	}
};
function isLoginRequired(error) {
	for (let cause = error; cause instanceof Error; cause = cause.cause) if (cause instanceof LoginRequiredError) return true;
	return false;
}
const callbackPath = "/callback";
/** The redirect URIs a dynamically registered client was registered with. */
function redirectUris(client) {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}
/**
* Keeps the OAuth client and tokens in the credentials file. Without a login
* context it only uses and refreshes what is stored: it never registers a
* client or starts a sign-in, so a normal command cannot hang on a browser.
*/
var CliOAuthProvider = class {
	store;
	login;
	verifier = "";
	discovery;
	constructor(store, login) {
		this.store = store;
		this.login = login;
	}
	get redirectUrl() {
		return this.login?.redirectUrl ?? `http://127.0.0.1${callbackPath}`;
	}
	get clientMetadata() {
		return {
			client_name: "Fulldev CLI",
			client_uri: "https://github.com/fulldotdev/cli",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none"
		};
	}
	state() {
		return this.login?.state ?? randomBytes(16).toString("base64url");
	}
	async clientInformation() {
		const { client } = await this.store.get();
		if (!this.login) {
			if (!client) throw new LoginRequiredError(this.store.serverUrl);
			return client;
		}
		return redirectUris(client).includes(this.login.redirectUrl) ? client : void 0;
	}
	async saveClientInformation(client) {
		await this.store.update((current) => ({
			...current,
			client
		}));
	}
	async tokens() {
		return (await this.store.get()).tokens;
	}
	async saveTokens(tokens) {
		await this.store.update((current) => ({
			...current,
			tokens,
			savedAt: Date.now()
		}));
	}
	async redirectToAuthorization(authorizationUrl) {
		if (!this.login) throw new LoginRequiredError(this.store.serverUrl);
		await this.login.onAuthorizationUrl(authorizationUrl);
	}
	saveCodeVerifier(verifier) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
	saveDiscoveryState(state) {
		this.discovery = state;
	}
	discoveryState() {
		return this.discovery;
	}
	async invalidateCredentials(scope) {
		if (scope === "verifier") this.verifier = "";
		if (scope === "discovery" || scope === "all") this.discovery = void 0;
		if (scope === "all" || scope === "client" || scope === "tokens") await this.store.update(({ client, tokens }) => ({
			...scope === "tokens" && client ? { client } : {},
			...scope === "client" && tokens ? { tokens } : {}
		}));
	}
};
const page = (message) => `<!doctype html><meta charset="utf-8"><title>Fulldev CLI</title><body style="font-family:system-ui;padding:3rem"><p>${message}</p></body>`;
/** Listens on 127.0.0.1 for the authorization server's redirect. */
async function listenForCallback(preferredPort) {
	let receive = () => {};
	const received = new Promise((resolve) => {
		receive = resolve;
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== callbackPath) {
			response.writeHead(404).end();
			return;
		}
		const failed = url.searchParams.has("error");
		response.writeHead(failed ? 400 : 200, { "content-type": "text/html" }).end(page(failed ? "Sign-in did not complete. You can close this tab and check the terminal." : "Sign-in received. You can close this tab and return to the terminal."));
		receive(url.searchParams);
	});
	const listen = (port) => new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	try {
		await listen(preferredPort ?? 0);
	} catch (error) {
		if (preferredPort === void 0) throw error;
		await listen(0);
	}
	return {
		port: server.address().port,
		wait: async (timeoutMs) => {
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`Sign-in timed out after ${Math.round(timeoutMs / 6e4)} minutes.`)), timeoutMs);
			});
			try {
				return await Promise.race([received, timeout]);
			} finally {
				clearTimeout(timer);
			}
		},
		close: () => {
			server.closeAllConnections();
			server.close();
		}
	};
}
/** Opens a URL in the system browser; the URL is printed as well. */
function openBrowser(url) {
	const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", [
		"/c",
		"start",
		"",
		url.replaceAll("&", "^&")
	]] : ["xdg-open", [url]];
	try {
		const child = spawn(command, args, {
			stdio: "ignore",
			detached: true
		});
		child.on("error", () => {});
		child.unref();
	} catch {}
}
/**
* Signs in with the authorization code flow and PKCE: discovery from the MCP
* URL, dynamic client registration when needed, the system browser and a
* loopback redirect. The registered client and its port are reused.
*/
async function login(serverUrl, store, { browser, log, timeoutMs = 3e5 }) {
	const { client } = await store.get();
	const registered = redirectUris(client)[0];
	const callback = await listenForCallback(registered ? Number(new URL(registered).port) || void 0 : void 0);
	try {
		const state = randomBytes(16).toString("base64url");
		const provider = new CliOAuthProvider(store, {
			redirectUrl: `http://127.0.0.1:${callback.port}${callbackPath}`,
			state,
			onAuthorizationUrl: (url) => {
				log(`Sign in to Fulldev in your browser. If it does not open, open:`);
				log(url.href);
				if (browser) openBrowser(url.href);
			}
		});
		if (await auth(provider, {
			serverUrl,
			forceReauthorization: true
		}) === "AUTHORIZED") return;
		const params = await callback.wait(timeoutMs);
		if (params.get("state") !== state) throw new Error("Sign-in failed: the response did not match this login.");
		const error = params.get("error");
		if (error) throw new Error(`Sign-in failed: ${[error, params.get("error_description")].filter(Boolean).join(": ")}`);
		const code = params.get("code");
		if (!code) throw new Error("Sign-in failed: no authorization code.");
		await auth(provider, {
			serverUrl,
			authorizationCode: code,
			iss: params.get("iss") ?? void 0
		});
	} finally {
		callback.close();
	}
}
//#endregion
//#region src/result.ts
/** A tool result as JSON: its structured content, or its text parsed as JSON. */
function toolOutput(result) {
	if (result.structuredContent !== void 0) return result.structuredContent;
	const values = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).map((text) => {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	});
	return values.length === 1 ? values[0] : values;
}
/** A failed tool result as an error object, also when the server sent plain text. */
function toolError(result) {
	const output = toolOutput(result);
	return output !== null && typeof output === "object" && !Array.isArray(output) ? output : { error: {
		code: "TOOL_ERROR",
		message: output
	} };
}
//#endregion
//#region src/form-wait.ts
/** The one tool the CLI names itself. */
const waitTool = "wait_for_form";
const maxFailures = 3;
const retryMs = 5e3;
function minutes(ms) {
	const total = Math.max(0, Math.round(ms / 1e3));
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}
/**
* Calls wait_for_form while it answers waiting true. Each call waits on the
* server, so the loop does not sleep between rounds. Network failures are
* retried a few times; tool and protocol errors end the wait.
*/
async function waitForForm(callTool, { branchId, formId, timeoutMs, progress = () => {}, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
	const deadline = now() + timeoutMs;
	let failures = 0;
	for (let round = 1; now() < deadline; round++) {
		let result;
		try {
			result = await callTool(waitTool, {
				branchId,
				formId
			});
			failures = 0;
		} catch (error) {
			if (isLoginRequired(error) || error instanceof ProtocolError || ++failures >= maxFailures) throw error;
			progress(`The request failed (${error.message}); retrying.`);
			await sleep(retryMs);
			continue;
		}
		if (result.isError) return {
			status: "error",
			error: toolError(result)
		};
		const output = toolOutput(result);
		if (!(output !== null && typeof output === "object" && output.waiting === true)) return {
			status: "done",
			result: output
		};
		progress(`Waiting for the person to send the form (round ${round}, ${minutes(deadline - now())} left).`);
	}
	return {
		status: "timeout",
		result: {
			waiting: true,
			branchId,
			formId,
			message: `Stopped waiting after ${minutes(timeoutMs)}. Run fulldev form wait ${branchId} ${formId} to keep waiting, or continue when the person says they are done.`
		}
	};
}
//#endregion
//#region src/input.ts
/** Reads a tool's arguments: a JSON object from the argument, a file or stdin. */
async function readToolArguments({ json, file, readStdin = () => text(process.stdin) }) {
	if (json !== void 0 && file !== void 0) throw new UsageError("Give the JSON as an argument or with --file, not both.");
	let source = "{}";
	let from = "the argument";
	if (file !== void 0) {
		from = file;
		try {
			source = await readFile(file, "utf8");
		} catch (error) {
			throw new UsageError(`Cannot read ${file}: ${error.code ?? error.message}`);
		}
	} else if (json === "-") {
		from = "stdin";
		source = await readStdin();
	} else if (json !== void 0) source = json;
	if (!source.trim()) source = "{}";
	let value;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new UsageError(`The tool input from ${from} is not valid JSON: ${error.message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`The tool input from ${from} must be a JSON object.`);
	return value;
}
//#endregion
//#region src/cli.ts
const exit = {
	error: 1,
	timeout: 2,
	login: 3
};
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const printError = (value) => process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
const hint = (line) => process.stderr.write(`${line}\n`);
/** A tool call can wait on the server for up to a minute. */
const requestTimeoutMs = 12e4;
async function connect(serverUrl, store) {
	if (!(await store.get()).tokens) throw new LoginRequiredError(serverUrl);
	const client = new Client({
		name: "fulldev-cli",
		version
	});
	const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: new CliOAuthProvider(store) });
	try {
		await client.connect(transport, { timeout: requestTimeoutMs });
	} catch (error) {
		throw signInError(error, serverUrl);
	}
	return client;
}
/** A rejected or expired sign-in, from any layer, becomes LoginRequiredError. */
function signInError(error, serverUrl) {
	if (isLoginRequired(error)) return error;
	if (error instanceof UnauthorizedError || error instanceof SdkError && /401|unauthori[sz]ed/i.test(error.message)) return new LoginRequiredError(serverUrl);
	return error;
}
/** Runs an action with a connected client, signing in first when allowed. */
async function withClient(line, store, action) {
	const attempt = async () => {
		const client = await connect(line.url, store);
		try {
			return await action(client);
		} catch (error) {
			throw signInError(error, line.url);
		} finally {
			await client.close().catch(() => {});
		}
	};
	try {
		return await attempt();
	} catch (error) {
		if (!isLoginRequired(error) || !line.login) throw error;
		hint(`Not signed in to ${line.url}.`);
		await login(line.url, store, {
			browser: line.browser,
			log: hint
		});
		return attempt();
	}
}
async function listTools(client) {
	const tools = [];
	let cursor;
	do {
		const page = await client.listTools(cursor ? { cursor } : void 0);
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}
function claims(token) {
	try {
		const value = JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString());
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}
async function status(line, store) {
	const base = {
		server: line.url,
		credentials: store.path
	};
	if (!(await store.get()).tokens) {
		print({
			...base,
			signedIn: false
		});
		return exit.login;
	}
	let server;
	try {
		const client = await connect(line.url, store);
		server = client.getServerVersion();
		await client.close();
	} catch (error) {
		if (!isLoginRequired(error)) throw error;
		print({
			...base,
			signedIn: true,
			valid: false
		});
		return exit.login;
	}
	const { tokens, savedAt } = await store.get();
	const access = claims(tokens?.access_token);
	const identity = claims(tokens?.id_token);
	const expires = typeof access.exp === "number" ? access.exp * 1e3 : savedAt && tokens?.expires_in ? savedAt + tokens.expires_in * 1e3 : void 0;
	print({
		...base,
		signedIn: true,
		valid: true,
		email: identity.email,
		name: identity.name,
		userId: access.sub ?? identity.sub,
		organizationId: access.org_id,
		expiresAt: expires ? new Date(expires).toISOString() : void 0,
		serverName: server?.title ?? server?.name,
		serverVersion: server?.version
	});
	return 0;
}
async function run(line) {
	if (line.version) {
		process.stdout.write(`${version}\n`);
		return 0;
	}
	if (!line.command || line.help || line.command === "help") {
		process.stdout.write(help);
		return 0;
	}
	const store = new CredentialStore(line.url);
	const [first, second, third] = line.args;
	switch (line.command) {
		case "login":
			await login(line.url, store, {
				browser: line.browser,
				log: hint
			});
			hint("Signed in.");
			return status(line, store);
		case "logout":
			await store.update(({ client }) => client ? { client } : {});
			print({
				server: line.url,
				signedIn: false
			});
			return 0;
		case "status": return status(line, store);
		case "instructions": {
			const text = await withClient(line, store, async (client) => client.getInstructions());
			if (!text) hint("The server sent no instructions.");
			else process.stdout.write(`${text}\n`);
			return 0;
		}
		case "tools": {
			const tools = await withClient(line, store, listTools);
			if (!first) {
				print(tools.map((tool) => ({
					name: tool.name,
					title: tool.title ?? tool.annotations?.title,
					description: tool.description?.split("\n")[0]
				})));
				hint("Run fulldev tools <name> for a tool's input schema.");
				return 0;
			}
			const tool = tools.find((candidate) => candidate.name === first);
			if (!tool) {
				printError({ error: {
					code: "NOT_FOUND",
					message: `No tool named ${first}.`
				} });
				return exit.error;
			}
			print({
				name: tool.name,
				title: tool.title ?? tool.annotations?.title,
				description: tool.description,
				inputSchema: tool.inputSchema
			});
			return 0;
		}
		case "call": {
			const args = await readToolArguments({
				json: second,
				file: line.file
			});
			const result = await withClient(line, store, (client) => client.callTool({
				name: first,
				arguments: args
			}, { timeout: requestTimeoutMs }));
			if (result.isError) {
				printError(toolError(result));
				return exit.error;
			}
			print(toolOutput(result));
			return 0;
		}
		case "form": {
			const outcome = await withClient(line, store, (client) => waitForForm((name, args) => client.callTool({
				name,
				arguments: args
			}, { timeout: requestTimeoutMs }), {
				branchId: second,
				formId: third,
				timeoutMs: line.timeoutMinutes * 6e4,
				progress: hint
			}));
			if (outcome.status === "error") {
				printError(outcome.error);
				return exit.error;
			}
			print(outcome.result);
			return outcome.status === "timeout" ? exit.timeout : 0;
		}
	}
	throw new UsageError(`Unknown command: ${line.command}`);
}
async function main() {
	try {
		process.exitCode = await run(parseCommandLine(process.argv.slice(2)));
	} catch (error) {
		if (error instanceof UsageError) {
			hint(`${error.message}\nRun fulldev help for usage.`);
			process.exitCode = exit.error;
		} else if (isLoginRequired(error)) {
			printError({ error: {
				code: "UNAUTHORIZED",
				message: error.message
			} });
			process.exitCode = exit.login;
		} else {
			printError({ error: {
				code: error instanceof ProtocolError ? error.code : error instanceof Error ? error.name : "ERROR",
				message: error instanceof Error ? error.message : String(error)
			} });
			process.exitCode = exit.error;
		}
	}
}
await main();
//#endregion
export {};
