#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client, OAuthError, OAuthErrorCode, ProtocolError, SdkError, StreamableHTTPClientTransport, UnauthorizedError, auth, checkResourceAllowed, discoverAuthorizationServerMetadata, discoverOAuthServerInfo, refreshAuthorization, resourceUrlFromServerUrl } from "@modelcontextprotocol/client";
import { parseArgs } from "node:util";
import { text } from "node:stream/consumers";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region src/errors.ts
const exitCodes = {
	ok: 0,
	error: 1,
	timeout: 2,
	signIn: 3,
	usage: 64
};
/** An error the CLI reports as {"error":{"code","message",...}} with an exit code. */
var CliError = class extends Error {
	code;
	exitCode;
	details;
	constructor(code, message, exitCode = exitCodes.error, details = {}) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
		this.details = details;
		this.name = "CliError";
	}
};
/** A mistake in how the CLI was called. */
var UsageError = class extends CliError {
	constructor(message, help = "fulldev --help") {
		super("USAGE", message, exitCodes.usage, { help });
		this.name = "UsageError";
	}
};
/** A command needs a sign-in that it may not start itself. */
var SignInRequiredError = class extends CliError {
	target;
	constructor(target) {
		const command = `fulldev login ${target.name}${target.urlFromFlag ? ` --url ${target.url}` : ""}`;
		super("SIGN_IN_REQUIRED", `Not signed in to ${target.title}. Run: ${command}`, exitCodes.signIn, {
			product: target.name,
			server: target.url,
			command
		});
		this.target = target;
		this.name = "SignInRequiredError";
	}
};
function isSignInRequired(error) {
	return findCause(error, SignInRequiredError) !== void 0;
}
/** The first error in the cause chain that is an instance of `type`. */
function findCause(error, type) {
	for (let cause = error; cause instanceof Error; cause = cause.cause) if (cause instanceof type) return cause;
}
/** Any error as the one JSON object the CLI prints on stderr, with its exit code. */
function describeError(error) {
	const cli = findCause(error, CliError);
	if (cli) return {
		body: { error: {
			code: cli.code,
			message: cli.message,
			...cli.details
		} },
		exitCode: cli.exitCode
	};
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof OAuthError) return {
		body: { error: {
			code: "OAUTH_ERROR",
			message,
			oauthError: error.code
		} },
		exitCode: exitCodes.error
	};
	if (error instanceof ProtocolError) return {
		body: { error: {
			code: "PROTOCOL_ERROR",
			message,
			protocolCode: error.code
		} },
		exitCode: exitCodes.error
	};
	if (error instanceof TypeError && /fetch failed/i.test(message)) return {
		body: { error: {
			code: "NETWORK_ERROR",
			message: `${message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
		} },
		exitCode: exitCodes.error
	};
	return {
		body: { error: {
			code: "ERROR",
			message
		} },
		exitCode: exitCodes.error
	};
}
//#endregion
//#region src/credentials.ts
function withoutStamp(stored) {
	const credentials = { ...stored };
	delete credentials.writtenAt;
	return credentials;
}
const keychainService = "fulldev";
/** The OS keychain through @napi-rs/keyring; rejects when it cannot load. */
async function openKeychain() {
	const { AsyncEntry } = await import("@napi-rs/keyring");
	const entry = (account) => new AsyncEntry(keychainService, account);
	return {
		get: async (account) => await entry(account).getPassword() ?? void 0,
		set: (account, secret) => entry(account).setPassword(secret),
		delete: async (account) => {
			await entry(account).deleteCredential();
		}
	};
}
function configDirectory(env = process.env) {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fulldev");
}
const held = new AsyncLocalStorage();
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/**
* Runs `action` while holding a lock file, so parallel fulldev processes take
* turns updating credentials, for example when two refresh the same token.
* Nested calls in the same action reuse the lock. A lock left by a process
* that ended, or older than `staleMs`, is taken over.
*/
async function withLock(path, action, { timeoutMs = 6e4, staleMs = 12e4 } = {}) {
	if (held.getStore()) return action();
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const handle = await open(path, "wx", 384);
			await handle.writeFile(String(process.pid));
			await handle.close();
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		const [owner, info] = await Promise.all([readFile(path, "utf8").catch(() => ""), stat(path).catch(() => void 0)]);
		const pid = Number(owner);
		if (Number.isInteger(pid) && pid > 0 && !processAlive(pid) || info !== void 0 && Date.now() - info.mtimeMs > staleMs) {
			await rm(path, { force: true });
			continue;
		}
		if (Date.now() > deadline) throw new Error(`Another fulldev process holds ${path}. Try again, or delete the file if no fulldev command is running.`);
		await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
	}
	try {
		return await held.run(true, action);
	} finally {
		await rm(path, { force: true });
	}
}
const isEmpty = (credentials) => Object.keys(credentials).length === 0;
/**
* Keeps credentials per product server in the OS keychain (service "fulldev",
* account = the MCP URL). When the keychain is unavailable or rejects a write,
* it uses a JSON file readable only by this user instead.
*/
var CredentialStore = class {
	directory;
	loadKeychain;
	filePath;
	lockPath;
	/** The 0.1.0 file, removed once by migrate(). */
	legacyPath;
	/** Why the keychain is not used, once it failed. */
	keychainError;
	keychain;
	constructor(directory = configDirectory(), loadKeychain = openKeychain) {
		this.directory = directory;
		this.loadKeychain = loadKeychain;
		this.filePath = join(directory, "auth.json");
		this.lockPath = join(directory, "auth.lock");
		this.legacyPath = join(directory, "credentials.json");
	}
	/** Where new credentials go. */
	async storage() {
		return await this.openKeychain() ? "keychain" : "file";
	}
	openKeychain() {
		this.keychain ??= this.loadKeychain().catch((error) => {
			this.keychainError = error.message;
		});
		return this.keychain;
	}
	disableKeychain(error) {
		this.keychainError = error.message;
		this.keychain = Promise.resolve(void 0);
	}
	locked(action) {
		return withLock(this.lockPath, action);
	}
	/** The server's credentials and where they were found. */
	async read(serverUrl) {
		let fromKeychain;
		const keychain = await this.openKeychain();
		if (keychain) try {
			const secret = await keychain.get(serverUrl);
			if (secret) fromKeychain = JSON.parse(secret);
		} catch (error) {
			this.disableKeychain(error);
		}
		const fromFile = (await this.readFile()).servers[serverUrl];
		if (fromKeychain && (!fromFile || (fromKeychain.writtenAt ?? 0) >= (fromFile.writtenAt ?? 0))) return {
			credentials: withoutStamp(fromKeychain),
			storage: "keychain"
		};
		return fromFile ? {
			credentials: withoutStamp(fromFile),
			storage: "file"
		} : { credentials: {} };
	}
	async get(serverUrl) {
		return (await this.read(serverUrl)).credentials;
	}
	/** Changes one server's credentials while holding the lock. */
	update(serverUrl, change) {
		return this.locked(async () => {
			const next = change(await this.get(serverUrl));
			if (isEmpty(next)) await this.delete(serverUrl);
			else await this.write(serverUrl, next);
		});
	}
	async write(serverUrl, record) {
		const credentials = {
			...record,
			writtenAt: Date.now()
		};
		const keychain = await this.openKeychain();
		if (keychain) try {
			await keychain.set(serverUrl, JSON.stringify(credentials));
			await this.changeFile((servers) => {
				delete servers[serverUrl];
			});
			return;
		} catch (error) {
			this.disableKeychain(error);
			await keychain.delete(serverUrl).catch(() => {});
		}
		await this.changeFile((servers) => {
			servers[serverUrl] = credentials;
		});
	}
	async delete(serverUrl) {
		await this.changeFile((servers) => {
			delete servers[serverUrl];
		});
		const keychain = await this.openKeychain();
		if (!keychain) return;
		try {
			await keychain.delete(serverUrl);
		} catch (error) {
			if (await keychain.get(serverUrl).catch(() => void 0)) throw new CliError("KEYCHAIN_ERROR", `The sign-in could not be removed from the OS keychain: ${error.message}. Remove the entry for ${serverUrl} under the service fulldev, or run this command in a terminal on this computer.`);
			this.disableKeychain(error);
		}
	}
	async readFile() {
		try {
			const data = JSON.parse(await readFile(this.filePath, "utf8"));
			if (data.servers && typeof data.servers === "object") return {
				version: 2,
				servers: data.servers
			};
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		return {
			version: 2,
			servers: {}
		};
	}
	/** Rewrites the file readable only by this user, or deletes it when empty. */
	async changeFile(change) {
		const data = await this.readFile();
		const before = JSON.stringify(data);
		change(data.servers);
		if (JSON.stringify(data) === before) return;
		if (Object.keys(data.servers).length === 0) {
			await rm(this.filePath, { force: true });
			return;
		}
		await mkdir(this.directory, {
			recursive: true,
			mode: 448
		});
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 384 });
		await chmod(temporary, 384);
		await rename(temporary, this.filePath);
	}
	/**
	* Removes the credentials file of fulldev 0.1.0 once. Its tokens belong to
	* a dynamically registered client that the CLI no longer uses, so they are
	* dropped. Returns the servers that were signed in with their credentials,
	* so their tokens can be revoked and a new sign-in asked for.
	*/
	async migrate() {
		if (!await stat(this.legacyPath).catch(() => void 0)) return [];
		return this.locked(async () => {
			let data;
			try {
				data = JSON.parse(await readFile(this.legacyPath, "utf8"));
			} catch (error) {
				if (error.code === "ENOENT") return [];
				if (!(error instanceof SyntaxError)) throw error;
			}
			const servers = data && typeof data === "object" && "servers" in data ? data.servers : {};
			await rm(this.legacyPath, { force: true });
			return Object.entries(servers).filter(([, credentials]) => credentials.tokens).map(([url, credentials]) => ({
				url,
				credentials
			}));
		});
	}
};
//#endregion
//#region package.json
var version = "0.3.0";
//#endregion
//#region src/products.ts
const products = [
	{
		name: "cms",
		title: "Fulldev CMS",
		url: "https://cms.full.dev/mcp",
		description: "Edit your website: text, pages, images and settings, through a pull request.",
		forms: true
	},
	{
		name: "connect",
		title: "Fulldev Connect",
		url: "https://connect.full.dev/mcp",
		description: "Use your organization's business tools, such as Shopify, with the access Fulldev grants you."
	},
	{
		name: "scan",
		title: "Fulldev Scan",
		url: "https://scan.full.dev/mcp",
		description: "Scan whole websites for problems. For administrators only."
	},
	{
		name: "sites",
		title: "Fulldev Sites",
		url: "https://sites.full.dev/mcp",
		description: "Have Fulldev make a finished website from a brief and tested design options. For administrators only for now."
	}
];
function findProduct(name) {
	return products.find((product) => product.name === name);
}
/** The environment variable that overrides a product's URL, such as FULLDEV_CMS_URL. */
function urlVariable(product) {
	return `FULLDEV_${product.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_URL`;
}
/** The product's server: --url, then FULLDEV_<PRODUCT>_URL, then the default. */
function resolveTarget(product, flagUrl, env) {
	const url = flagUrl ?? env[urlVariable(product)] ?? product.url;
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new UsageError(`Not a valid server URL for ${product.name}: ${url}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new UsageError(`The server URL for ${product.name} must use https: ${url}`);
	return {
		...product,
		url: parsed.href,
		urlFromFlag: flagUrl !== void 0
	};
}
//#endregion
//#region src/args.ts
const rootCommands = {
	login: {
		usage: "fulldev login [product...] [--no-browser] [--url <mcp url>]",
		summary: "Sign in (all products by default)",
		options: ["browser", "url"],
		details: `Signs in to each product in turn in your browser, where you choose your
organization. Each product gets its own tokens; the browser session is shared,
so after the first product the others are quick. Run fulldev login <product>
again to switch that product to another organization.`
	},
	logout: {
		usage: "fulldev logout [product...] [--url <mcp url>]",
		summary: "Sign out and revoke the tokens (all products by default)",
		options: ["url"],
		details: `Revokes the product's refresh token at the authorization server and deletes
the tokens from this computer. The access token cannot be revoked and expires
within a day. When revoking fails, the local sign-out still happens and the
result says so.`
	},
	status: {
		usage: "fulldev status [product...] [--url <mcp url>]",
		summary: "Show the sign-in of each product",
		options: ["url"],
		details: `Prints, per product, whether you are signed in, whether the sign-in still
works, your email, organization and when the access token expires, and where
the tokens are stored. Exits with 3 when none of the listed products can be
used, and with 1 when a server could not be reached to check it. Read each
product's signedIn and valid to see which one needs fulldev login.`
	},
	help: {
		usage: "fulldev help [command...]",
		summary: "Show help for a command"
	}
};
const productCommands = {
	instructions: {
		usage: "fulldev <product> instructions",
		summary: "The product's instructions for agents; read them first",
		options: [
			"url",
			"login",
			"browser"
		],
		details: "Prints the instructions the server sends, as plain text."
	},
	tools: {
		usage: "fulldev <product> tools [name]",
		summary: "List the tools, or show one tool",
		options: [
			"url",
			"login",
			"browser"
		],
		details: `Without a name: the name, title and first line of the description of each
tool. With a name: its description, input schema, output schema and
annotations.`
	},
	call: {
		usage: "fulldev <product> call <tool> [json | -] [--file <path>]",
		summary: "Call a tool with a JSON object",
		options: [
			"file",
			"url",
			"login",
			"browser"
		],
		details: `The tool's input is a JSON object: the argument, a file with --file, or
stdin with -. Without input it sends {}. Prints the tool's result as JSON on
stdout. When the tool fails, prints its error on stderr and exits with 1.`
	}
};
const formWait = {
	usage: "fulldev <product> form wait <branchId> <formId> [--timeout <minutes>]",
	summary: "Wait until the person sends a form",
	options: [
		"timeout",
		"url",
		"login",
		"browser"
	],
	details: `Calls wait_for_form until the person sends the form, with a progress line on
stderr each round, then prints the result. After --timeout minutes (default
30) it prints the form id and exits with 2, so you can run it again.`
};
const optionHelp = {
	url: "--url <mcp url>      Use another server for the product, such as a deploy preview",
	file: "-f, --file <path>    Read the tool's JSON input from a file",
	timeout: "--timeout <minutes>  How long to wait (default 30)",
	login: "--no-login           Fail with exit code 3 instead of signing in",
	browser: "--no-browser         Print the sign-in link without opening a browser"
};
const footer = `Data is JSON on stdout; progress lines go to stderr. Every error is one JSON
object on stderr: {"error":{"code","message",...}}.
Exit codes: 0 ok, 1 error, 2 form wait timed out, 3 sign-in needed, 64 usage error.
`;
const pad = (text, width) => text.padEnd(width);
function productTopics(product) {
	const name = (topic) => ({
		...topic,
		usage: topic.usage.replace("<product>", product.name)
	});
	const topics = {};
	for (const [command, topic] of Object.entries(productCommands)) topics[`${product.name} ${command}`] = name(topic);
	if (product.forms) {
		const wait = name(formWait);
		topics[`${product.name} form`] = wait;
		topics[`${product.name} form wait`] = wait;
	}
	return topics;
}
function rootHelp() {
	const width = Math.max(...products.map((product) => product.name.length)) + 4;
	return `Fulldev CLI: use Fulldev products from a terminal or an AI agent.

Usage:
  fulldev <product> <command> [options]
${Object.values(rootCommands).map((topic) => `  ${pad(topic.usage.split(" [--")[0], 32)}${topic.summary}`).join("\n")}

Products:
${products.map((product) => `  ${pad(product.name, width)}${product.description}`).join("\n")}

Product commands:
${[...Object.values(productCommands), {
		...formWait,
		usage: formWait.usage.replace("<product>", "cms")
	}].map((topic) => `  ${topic.usage.split(" [--")[0]}\n      ${topic.summary}`).join("\n")}

Run fulldev <product> instructions first and follow them.
Run fulldev help <command...> for a command's options, for example
fulldev help cms call.

Options:
  -h, --help     Show help
  -v, --version  Show the version

${footer}`;
}
function productHelp(product) {
	const topics = Object.values(productTopics(product)).filter((topic, index, all) => all.indexOf(topic) === index);
	return `${product.title}

${product.description}

Server: ${product.url} (${urlVariable(product)} or --url overrides it)

Usage:
${topics.map((topic) => `  ${topic.usage}\n      ${topic.summary}`).join("\n")}

Run fulldev ${product.name} instructions first and follow them.
Sign in with fulldev login ${product.name}.

${footer}`;
}
function topicHelp(topic) {
	const options = topic.options?.map((option) => `  ${optionHelp[option]}`);
	return `Usage: ${topic.usage}

${topic.summary}.
${topic.details ? `\n${topic.details}\n` : ""}${options?.length ? `\nOptions:\n${options.join("\n")}\n` : ""}
${footer}`;
}
/** The help text for a topic such as "", "login", "cms" or "cms call". */
function helpText(topic) {
	if (topic === "") return rootHelp();
	const root = rootCommands[topic];
	if (root) return topicHelp(root);
	const product = findProduct(topic);
	if (product) return productHelp(product);
	const [name] = topic.split(" ");
	const owner = findProduct(name ?? "");
	const found = owner ? productTopics(owner)[topic] : void 0;
	return found ? topicHelp(found) : void 0;
}
/** The longest leading words of `words` that name a help topic. */
function closestTopic(words) {
	for (let length = Math.min(words.length, 3); length > 0; length--) {
		const topic = words.slice(0, length).join(" ");
		if (helpText(topic) !== void 0) return topic;
	}
	return "";
}
const helpFor = (topic) => topic ? `fulldev ${topic} --help` : "fulldev --help";
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
				login: { type: "boolean" },
				browser: { type: "boolean" },
				help: {
					type: "boolean",
					short: "h"
				},
				version: {
					type: "boolean",
					short: "v"
				}
			}
		});
	} catch (error) {
		throw new UsageError(error.message, helpFor(closestTopic(argv.filter((word) => !word.startsWith("-")))));
	}
	const { values, positionals } = parsed;
	if (values.version) return { kind: "version" };
	if (positionals[0] === "help") {
		const topic = positionals.slice(1).join(" ");
		if (helpText(topic) === void 0) throw new UsageError(`No help for: ${topic}`);
		return {
			kind: "help",
			topic
		};
	}
	if (values.help) return {
		kind: "help",
		topic: closestTopic(positionals)
	};
	if (positionals.length === 0) return {
		kind: "help",
		topic: ""
	};
	const [first, ...rest] = positionals;
	const given = Object.keys(values).filter((key) => values[key] !== void 0);
	const allow = (topic, options = []) => {
		const extra = given.find((key) => !options.includes(key));
		if (extra) throw new UsageError(`--${extra === "login" || extra === "browser" ? `no-${extra}` : extra} does not work with fulldev ${topic}.`, helpFor(topic));
	};
	if (first === "login" || first === "logout" || first === "status") {
		allow(first, rootCommands[first].options);
		const named = [...new Set(rest)].map((name) => {
			const product = findProduct(name);
			if (!product) throw new UsageError(`Unknown product: ${name}`, helpFor(first));
			return product;
		});
		if (values.url !== void 0 && named.length !== 1) throw new UsageError(`--url needs exactly one product, for example fulldev ${first} cms --url <mcp url>.`, helpFor(first));
		const targets = (named.length ? named : products).map((product) => resolveTarget(product, values.url, env));
		if (first === "login") return {
			kind: "login",
			targets,
			browser: values.browser ?? true
		};
		return {
			kind: first,
			targets
		};
	}
	const product = findProduct(first);
	if (!product) throw new UsageError(`Unknown command or product: ${first}`);
	const [command, ...args] = rest;
	if (command === void 0) {
		allow(product.name);
		return {
			kind: "help",
			topic: product.name
		};
	}
	const topic = `${product.name} ${command}`;
	const known = productTopics(product)[topic];
	if (!known) throw new UsageError(`Unknown command: fulldev ${topic}`, helpFor(product.name));
	allow(topic, known.options);
	const usage = (count) => {
		if (!count) throw new UsageError(`Usage: ${known.usage}`, helpFor(topic));
	};
	const target = resolveTarget(product, values.url, env);
	const session = {
		login: values.login ?? true,
		browser: values.browser ?? true
	};
	switch (command) {
		case "instructions":
			usage(args.length === 0);
			return {
				kind: "instructions",
				target,
				session
			};
		case "tools":
			usage(args.length <= 1);
			return {
				kind: "tools",
				target,
				session,
				name: args[0]
			};
		case "call":
			usage(args.length === 1 || args.length === 2);
			return {
				kind: "call",
				target,
				session,
				tool: args[0],
				json: args[1],
				file: values.file
			};
		default: {
			usage(args[0] === "wait" && args.length === 3);
			const timeoutMinutes = values.timeout === void 0 ? 30 : Number(values.timeout);
			if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new UsageError("--timeout must be a number of minutes above 0.", helpFor(topic));
			return {
				kind: "form-wait",
				target,
				session,
				branchId: args[1],
				formId: args[2],
				timeoutMinutes
			};
		}
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
/** A failed tool result as {"error":{"code","message",...}}, whatever the server sent. */
function toolError(result) {
	const output = toolOutput(result);
	if (output !== null && typeof output === "object" && !Array.isArray(output)) {
		const { error } = output;
		if (error !== null && typeof error === "object" && !Array.isArray(error)) return output;
		return { error: {
			code: "TOOL_ERROR",
			message: "The tool failed.",
			details: output
		} };
	}
	return { error: {
		code: "TOOL_ERROR",
		message: typeof output === "string" ? output : JSON.stringify(output)
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
function wait(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}
/**
* Calls wait_for_form while it answers waiting true. Each call waits on the
* server, so the loop does not sleep between rounds. Network failures are
* retried a few times; tool and protocol errors end the wait. The deadline
* also aborts a request that is still running.
*/
async function waitForForm(callTool, { branchId, formId, timeoutMs, product = "cms", progress = () => {}, now = Date.now, sleep = wait }) {
	const deadline = now() + timeoutMs;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const { signal } = controller;
	const aborted = () => signal.aborted;
	let failures = 0;
	try {
		for (let round = 1; now() < deadline && !aborted(); round++) {
			let result;
			try {
				result = await callTool(waitTool, {
					branchId,
					formId
				}, signal);
				failures = 0;
			} catch (error) {
				if (aborted()) break;
				if (isSignInRequired(error) || error instanceof ProtocolError || ++failures >= maxFailures) throw error;
				progress(`The request failed (${error.message}); retrying.`);
				await sleep(retryMs, signal);
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
	} finally {
		clearTimeout(timer);
	}
	return {
		status: "timeout",
		result: {
			waiting: true,
			branchId,
			formId,
			message: `Stopped waiting after ${minutes(timeoutMs)}. Run fulldev ${product} form wait ${branchId} ${formId} to keep waiting, or continue when the person says they are done.`
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
//#region src/oauth.ts
/**
* The Fulldev CLI's pre-registered public OAuth client per authorization
* server issuer. An issuer that is not listed, such as the Clerk development
* instance behind a deploy preview, gets a dynamically registered client.
*/
const clientIds = { "https://clerk.full.dev": "3Gjxf97mGc2QVnTv" };
const trimSlash = (url) => url.replace(/\/+$/, "");
/** The pre-registered client for an issuer, if there is one. */
function fixedClient(issuer) {
	const clientId = issuer ? clientIds[trimSlash(issuer)] : void 0;
	return clientId ? {
		client_id: clientId,
		issuer
	} : void 0;
}
/** The client to use with an issuer: the fixed one, else the registered one. */
function clientFor(issuer, credentials) {
	return fixedClient(issuer) ?? credentials.client;
}
/** The claims of a JWT, or {} for an opaque token. */
function claims(token) {
	try {
		const value = JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString());
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}
/** When the access token expires, in milliseconds, if known. */
function expiresAt(credentials) {
	const { exp } = claims(credentials.tokens?.access_token);
	if (typeof exp === "number") return exp * 1e3;
	const { savedAt, tokens } = credentials;
	return savedAt && tokens?.expires_in ? savedAt + tokens.expires_in * 1e3 : void 0;
}
/** A copy of the credentials without one field. */
function without(credentials, key) {
	const copy = { ...credentials };
	delete copy[key];
	return copy;
}
const refreshEarlyMs = 6e4;
function needsRefresh(credentials, now = Date.now()) {
	const expires = expiresAt(credentials);
	return expires !== void 0 && expires - refreshEarlyMs <= now;
}
/** Saves tokens for a target, keeping only the email from the ID token. */
async function saveTokens(store, target, tokens, issuer) {
	const { id_token: idToken, ...kept } = tokens;
	const { email } = claims(idToken);
	await store.update(target.url, (current) => ({
		...current,
		issuer,
		tokens: kept,
		email: typeof email === "string" ? email : current.email,
		savedAt: Date.now()
	}));
}
/** Finds the target's authorization server and checks its resource. */
async function discover(target, fetchFn) {
	const info = await discoverOAuthServerInfo(target.url, { fetchFn });
	const metadata = info.authorizationServerMetadata;
	const resource = info.resourceMetadata?.resource;
	if (!metadata || !info.resourceMetadata || !resource) throw new CliError("DISCOVERY_FAILED", `${target.url} does not publish OAuth metadata for its MCP server.`);
	if (!checkResourceAllowed({
		requestedResource: resourceUrlFromServerUrl(target.url),
		configuredResource: resource
	})) throw new CliError("RESOURCE_MISMATCH", `The server names its resource ${resource}, which does not match ${target.url}.`);
	return {
		authorizationServerUrl: info.authorizationServerUrl,
		metadata,
		issuer: metadata.issuer,
		resource,
		resourceMetadata: info.resourceMetadata
	};
}
const callbackPath = "/callback";
/** The redirect URIs a dynamically registered client was registered with. */
function redirectUris(client) {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}
/**
* The SDK's view of one browser sign-in: the fixed client, or a registered
* one for an unknown issuer, with PKCE S256 and a loopback redirect.
*/
var BrowserLoginProvider = class {
	store;
	target;
	redirectUrl;
	loginState;
	onAuthorizationUrl;
	verifier = "";
	discovery;
	constructor(store, target, redirectUrl, loginState, onAuthorizationUrl) {
		this.store = store;
		this.target = target;
		this.redirectUrl = redirectUrl;
		this.loginState = loginState;
		this.onAuthorizationUrl = onAuthorizationUrl;
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
		return this.loginState;
	}
	async clientInformation(ctx) {
		const fixed = fixedClient(ctx?.issuer);
		if (fixed) return fixed;
		const { client } = await this.store.get(this.target.url);
		return redirectUris(client).includes(this.redirectUrl) ? client : void 0;
	}
	async saveClientInformation(client, ctx) {
		if (fixedClient(ctx?.issuer ?? client.issuer)) return;
		await this.store.update(this.target.url, (current) => ({
			...current,
			client
		}));
	}
	/** A sign-in always asks again, so it never reuses stored tokens. */
	tokens() {}
	async saveTokens(tokens, ctx) {
		const issuer = ctx?.issuer ?? tokens.issuer;
		await saveTokens(this.store, this.target, tokens, issuer ?? "");
	}
	redirectToAuthorization(authorizationUrl) {
		this.onAuthorizationUrl(authorizationUrl);
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
		if (scope === "client" || scope === "all") await this.store.update(this.target.url, (current) => without(current, "client"));
	}
};
const tile = `<svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7.68" fill="#0737ff"/><g transform="translate(10.72 6.8) scale(0.8)" fill="#ffffff">${[
	"M9.955 0.313C5.246 1.263 1.658 3.599 0.434 6.534C0.19 7.118 0.046 7.725 0.009 8.348C-0.003 8.552 0.11 8.743 0.294 8.83C0.479 8.917 0.698 8.883 0.848 8.744C1.78 7.881 4.717 5.41 10.404 4.48C11.847 4.244 12.134 3.917 11.95 2.206C11.766 0.495 11.389 0.024 9.955 0.313Z",
	"M9.88 6.991C5.285 7.935 2.974 9.921 2.178 10.698C0.632 12.206 0 13.835 0 15.33C0 19.489 4.773 22.976 11.193 23.899C11.753 23.979 11.894 23.839 11.976 23.179C12.057 22.518 11.949 22.386 11.392 22.29C6.958 21.533 3.726 19.389 3.58 16.84C3.535 16.049 3.76 14.692 5.536 13.328C6.736 12.406 8.42 11.671 10.4 11.223C11.851 10.893 12.152 10.624 11.938 8.886C11.725 7.148 11.338 6.691 9.88 6.991Z",
	"M11.193 17.238C5.987 16.49 3.213 14.334 2.104 13.229L4.381 12.195C5.161 13.214 7.18 14.91 11.392 15.63C11.949 15.725 12.057 15.858 11.976 16.518C11.894 17.179 11.753 17.319 11.193 17.238Z"
].map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;
const page = (message) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fulldev CLI</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f7f4;color:#2b2d33;font:16px/1.6 Geist,system-ui,sans-serif"><main style="max-width:28rem;padding:2rem;text-align:center">${tile}<p>${message}</p></main></body>`;
/** Listens on 127.0.0.1 for the authorization server's redirect (RFC 8252). */
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
		response.writeHead(failed ? 400 : 200, { "content-type": "text/html" }).end(page(failed ? "Sign-in did not complete. You can close this tab and check the terminal." : "Sign-in received. You can close this tab and return to the terminal."), () => receive(url.searchParams));
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
				timer = setTimeout(() => reject(new CliError("SIGN_IN_TIMEOUT", `Sign-in timed out after ${Math.round(timeoutMs / 6e4)} minutes.`)), timeoutMs);
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
* Signs in with the authorization code flow and PKCE S256, the system
* browser and a loopback redirect on an ephemeral port, asking for the
* product's MCP URL as the resource.
*/
async function browserLogin(target, store, { browser, log, timeoutMs = 3e5, fetchFn }) {
	const registered = redirectUris((await store.get(target.url)).client)[0];
	const callback = await listenForCallback(registered ? Number(new URL(registered).port) || void 0 : void 0);
	try {
		const state = randomBytes(16).toString("base64url");
		const provider = new BrowserLoginProvider(store, target, `http://127.0.0.1:${callback.port}${callbackPath}`, state, (url) => {
			log(`Sign in to ${target.title} in your browser. If it does not open, open:`);
			log(url.href);
			if (browser) openBrowser(url.href);
		});
		if (await auth(provider, {
			serverUrl: target.url,
			forceReauthorization: true,
			...fetchFn ? { fetchFn } : {}
		}) === "AUTHORIZED") return;
		const params = await callback.wait(timeoutMs);
		if (params.get("state") !== state) throw new CliError("SIGN_IN_FAILED", "Sign-in failed: the response did not match this sign-in.");
		const error = params.get("error");
		if (error) throw new CliError("SIGN_IN_FAILED", `Sign-in failed: ${[error, params.get("error_description")].filter(Boolean).join(": ")}`, void 0, { oauthError: error });
		const code = params.get("code");
		if (!code) throw new CliError("SIGN_IN_FAILED", "Sign-in failed: no authorization code.");
		await auth(provider, {
			serverUrl: target.url,
			authorizationCode: code,
			iss: params.get("iss") ?? void 0,
			...fetchFn ? { fetchFn } : {}
		});
	} finally {
		callback.close();
	}
}
const formHeaders = {
	"content-type": "application/x-www-form-urlencoded",
	accept: "application/json"
};
async function readJson(response) {
	try {
		const value = await response.json();
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}
const text$1 = (value) => typeof value === "string" ? value : void 0;
/**
* Refreshes the target's tokens. Call it while holding the store's lock.
* A refresh token the server no longer accepts is dropped, and the command
* then needs a new sign-in.
*/
async function refreshTokens(target, store, fetchFn) {
	const credentials = await store.get(target.url);
	const refreshToken = credentials.tokens?.refresh_token;
	if (!refreshToken) throw new SignInRequiredError(target);
	const discovery = await discover(target, fetchFn);
	const client = clientFor(discovery.issuer, credentials);
	if (!client || credentials.issuer && credentials.issuer !== discovery.issuer) throw new SignInRequiredError(target);
	let tokens;
	try {
		tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
			metadata: discovery.metadata,
			clientInformation: client,
			refreshToken,
			resource: new URL(discovery.resource),
			...fetchFn ? { fetchFn } : {}
		});
	} catch (error) {
		if (error instanceof OAuthError && (error.code === OAuthErrorCode.InvalidGrant || error.code === OAuthErrorCode.InvalidClient || error.code === OAuthErrorCode.UnauthorizedClient)) {
			await store.update(target.url, (current) => without(current, "tokens"));
			throw new SignInRequiredError(target);
		}
		throw error;
	}
	await saveTokens(store, target, tokens, discovery.issuer);
}
/**
* Revokes the refresh token (RFC 7009), sending the client_id as a public
* client. Never throws: the result says what failed.
*/
async function revokeTokens(target, credentials, fetchFn = fetch) {
	const { tokens } = credentials;
	if (!tokens) return { revoked: true };
	try {
		const metadata = credentials.issuer ? await discoverAuthorizationServerMetadata(credentials.issuer, { fetchFn }) : (await discover(target, fetchFn)).metadata;
		const endpoint = metadata?.revocation_endpoint;
		if (!endpoint) return {
			revoked: false,
			error: "The authorization server has no revocation endpoint."
		};
		const client = credentials.client ?? fixedClient(metadata.issuer);
		if (!client) return {
			revoked: false,
			error: "No OAuth client to revoke with."
		};
		const failures = [];
		for (const [token, hint] of [[tokens.refresh_token, "refresh_token"]]) {
			if (!token) continue;
			const body = new URLSearchParams({
				token,
				token_type_hint: hint,
				client_id: client.client_id
			});
			if (client.client_secret) body.set("client_secret", client.client_secret);
			const response = await fetchFn(endpoint, {
				method: "POST",
				headers: formHeaders,
				body
			});
			if (!response.ok) {
				const answer = await readJson(response);
				failures.push(`${hint}: ${[text$1(answer.error) ?? `HTTP ${response.status}`, text$1(answer.error_description)].filter(Boolean).join(": ")}`);
			}
		}
		return failures.length ? {
			revoked: false,
			error: `Revocation failed for ${failures.join("; ")}`
		} : { revoked: true };
	} catch (error) {
		return {
			revoked: false,
			error: error.message
		};
	}
}
/**
* Gives the MCP transport the stored access token of one product, refreshing
* it when it is about to expire or the server answers 401. Refreshes happen
* under the store's lock, and a token another process refreshed meanwhile is
* used instead of refreshing again. It never starts a sign-in.
*/
var StoredTokenAuth = class {
	target;
	store;
	sent;
	constructor(target, store) {
		this.target = target;
		this.store = store;
	}
	async refreshUnless(changed, fetchFn) {
		await this.store.locked(async () => {
			if (!changed(await this.store.get(this.target.url))) await refreshTokens(this.target, this.store, fetchFn);
		});
	}
	async token() {
		let credentials = await this.store.get(this.target.url);
		if (!credentials.tokens) throw new SignInRequiredError(this.target);
		if (needsRefresh(credentials)) {
			const stale = credentials.tokens.access_token;
			await this.refreshUnless((current) => current.tokens?.access_token !== stale && !needsRefresh(current));
			credentials = await this.store.get(this.target.url);
		}
		this.sent = credentials.tokens?.access_token;
		return this.sent;
	}
	async onUnauthorized(ctx) {
		await this.refreshUnless((current) => current.tokens?.access_token !== void 0 && current.tokens.access_token !== this.sent, ctx.fetchFn);
	}
};
//#endregion
//#region src/main.ts
/** A tool call can wait on the server for up to a minute. */
const requestTimeoutMs = 12e4;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
/** A rejected or expired sign-in, from any layer, becomes SignInRequiredError. */
function signInError(error, target) {
	if (isSignInRequired(error)) return error;
	if (error instanceof UnauthorizedError || error instanceof SdkError && /\b401\b|unauthori[sz]ed/i.test(error.message)) return new SignInRequiredError(target);
	return error;
}
async function connect(target, io) {
	if (!(await io.store.get(target.url)).tokens) throw new SignInRequiredError(target);
	const client = new Client({
		name: "fulldev-cli",
		version
	});
	const transport = new StreamableHTTPClientTransport(new URL(target.url), { authProvider: new StoredTokenAuth(target, io.store) });
	try {
		await client.connect(transport, { timeout: requestTimeoutMs });
	} catch (error) {
		throw signInError(error, target);
	}
	return client;
}
/**
* Runs an action with a connected client. When a sign-in is needed it starts
* one in the browser only for a person at a terminal; otherwise it fails at
* once with exit code 3.
*/
async function withClient(target, session, io, action) {
	const attempt = async () => {
		const client = await connect(target, io);
		try {
			return await action(client);
		} catch (error) {
			throw signInError(error, target);
		} finally {
			await client.close().catch(() => {});
		}
	};
	try {
		return await attempt();
	} catch (error) {
		if (!isSignInRequired(error) || !session.login || !io.interactive) throw error;
		io.stderr(`Not signed in to ${target.title}.\n`);
		await browserLogin(target, io.store, {
			browser: session.browser,
			log: (line) => io.stderr(`${line}\n`)
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
async function productStatus(target, io) {
	const { credentials, storage } = await io.store.read(target.url);
	const base = {
		product: target.name,
		server: target.url
	};
	if (!credentials.tokens) return {
		...base,
		signedIn: false
	};
	let valid = true;
	let error;
	try {
		await (await connect(target, io)).close().catch(() => {});
	} catch (cause) {
		if (isSignInRequired(cause)) valid = false;
		else {
			valid = void 0;
			error = cause.message;
		}
	}
	const current = await io.store.get(target.url);
	const access = claims(current.tokens?.access_token);
	const expires = expiresAt(current);
	return {
		...base,
		signedIn: Boolean(current.tokens),
		valid,
		...error ? { error } : {},
		email: current.email,
		organizationId: access.org_id,
		expiresAt: expires ? new Date(expires).toISOString() : void 0,
		storage
	};
}
async function status(targets, io) {
	const results = [];
	for (const target of targets) results.push(await productStatus(target, io));
	const storage = await io.store.storage();
	io.stdout(json({
		storage: storage === "keychain" ? {
			kind: "keychain",
			service: "fulldev"
		} : {
			kind: "file",
			path: io.store.filePath,
			reason: `The OS keychain is unavailable: ${io.store.keychainError}`
		},
		products: results
	}));
	if (!results.some((result) => result.signedIn && !("valid" in result && result.valid === false))) return exitCodes.signIn;
	return results.some((result) => "error" in result) ? exitCodes.error : exitCodes.ok;
}
async function logout(targets, io) {
	const results = [];
	for (const target of targets) {
		const credentials = await io.store.get(target.url);
		if (!credentials.tokens && !credentials.client) {
			results.push({
				product: target.name,
				signedIn: false
			});
			continue;
		}
		const revocation = await revokeTokens(target, credentials);
		if (!revocation.revoked) io.stderr(`Could not revoke the tokens of ${target.title}: ${revocation.error} They are deleted from this computer anyway.\n`);
		await io.store.update(target.url, () => ({}));
		results.push({
			product: target.name,
			signedIn: false,
			revoked: revocation.revoked,
			...revocation.error ? { revocationError: revocation.error } : {}
		});
	}
	io.stdout(json({ products: results }));
	return exitCodes.ok;
}
async function run(command, io) {
	const log = (line) => io.stderr(`${line}\n`);
	switch (command.kind) {
		case "version":
			io.stdout(`${version}\n`);
			return exitCodes.ok;
		case "help":
			io.stdout(helpText(command.topic) ?? "");
			return exitCodes.ok;
	}
	for (const { url, credentials } of await io.store.migrate()) {
		const product = products.find((candidate) => candidate.url === url);
		const name = product?.name;
		if (product) await revokeTokens({
			...product,
			urlFromFlag: false
		}, credentials);
		log(`fulldev now signs in per product and keeps tokens in the OS keychain. The sign-in from fulldev 0.1.0 for ${url} was removed; run fulldev login${name ? ` ${name}` : ""} to sign in again.`);
	}
	switch (command.kind) {
		case "login":
			for (const target of command.targets) {
				const previous = await io.store.get(target.url);
				await browserLogin(target, io.store, {
					browser: command.browser,
					log
				});
				if (previous.tokens) {
					const revocation = await revokeTokens(target, previous);
					if (!revocation.revoked) log(`Could not revoke the previous sign-in to ${target.title}: ${revocation.error}`);
				}
				log(`Signed in to ${target.title}.`);
			}
			return status(command.targets, io);
		case "logout": return logout(command.targets, io);
		case "status": return status(command.targets, io);
		case "instructions": {
			const text = await withClient(command.target, command.session, io, async (client) => client.getInstructions());
			if (!text) log("The server sent no instructions.");
			else io.stdout(`${text}\n`);
			return exitCodes.ok;
		}
		case "tools": {
			const tools = await withClient(command.target, command.session, io, listTools);
			if (!command.name) {
				io.stdout(json(tools.map((tool) => ({
					name: tool.name,
					title: tool.title ?? tool.annotations?.title,
					description: tool.description?.split("\n")[0]
				}))));
				return exitCodes.ok;
			}
			const tool = tools.find((candidate) => candidate.name === command.name);
			if (!tool) throw new CliError("NOT_FOUND", `${command.target.title} has no tool named ${command.name}. Run fulldev ${command.target.name} tools for the list.`);
			io.stdout(json({
				name: tool.name,
				title: tool.title ?? tool.annotations?.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				outputSchema: tool.outputSchema,
				annotations: tool.annotations
			}));
			return exitCodes.ok;
		}
		case "call": {
			const args = await readToolArguments({
				json: command.json,
				file: command.file
			});
			const result = await withClient(command.target, command.session, io, (client) => client.callTool({
				name: command.tool,
				arguments: args
			}, { timeout: requestTimeoutMs }));
			if (result.isError) {
				io.stderr(json(toolError(result)));
				return exitCodes.error;
			}
			io.stdout(json(toolOutput(result)));
			return exitCodes.ok;
		}
		case "form-wait": {
			const outcome = await withClient(command.target, command.session, io, (client) => waitForForm((name, args, signal) => client.callTool({
				name,
				arguments: args
			}, {
				timeout: requestTimeoutMs,
				signal
			}), {
				branchId: command.branchId,
				formId: command.formId,
				timeoutMs: command.timeoutMinutes * 6e4,
				product: command.target.name,
				progress: log
			}));
			if (outcome.status === "error") {
				io.stderr(json(outcome.error));
				return exitCodes.error;
			}
			io.stdout(json(outcome.result));
			return outcome.status === "timeout" ? exitCodes.timeout : exitCodes.ok;
		}
	}
}
/** Runs the CLI and returns the exit code; every error becomes one JSON object on stderr. */
async function main(argv, io) {
	try {
		return await run(parseCommandLine(argv, io.env), io);
	} catch (error) {
		const { body, exitCode } = describeError(error);
		io.stderr(json(body));
		return exitCode;
	}
}
//#endregion
//#region src/cli.ts
process.exitCode = await main(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
	env: process.env,
	store: new CredentialStore()
});
//#endregion
export {};
