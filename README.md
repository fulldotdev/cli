# Fulldev CLI

Use Fulldev apps from a terminal or an AI agent. The CLI is a thin client of the Fulldev MCP server at `https://app.full.dev/mcp`, which has the tools of every app your organization gives you: it reads the tools, their schemas, and the instructions from the server each time, so it stays in step with the apps. Each app's tools start with its name, such as `cms_`.

| App        | For                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `cms`      | Editing your website through the [Fulldev CMS](https://cms.full.dev)                                 |
| `connect`  | Your business tools, such as Shopify, through [Fulldev Connect](https://connect.full.dev)            |
| `scan`     | Scanning websites with [Fulldev Scan](https://scan.full.dev), for administrators only                |
| `sites`    | A finished website from [Fulldev Sites](https://sites.full.dev), for administrators only             |
| `pages`    | Reports and plans as web pages with [Fulldev Pages](https://pages.full.dev), for administrators only |
| `contacts` | The daily copy of your Google contacts with [Fulldev Contacts](https://contacts.full.dev)            |

## Install

Run it from npm. It needs Node.js 24 or later.

```sh
npx -y fulldev --help
pnpm dlx fulldev --help
```

Or install it once:

```sh
npm install -g fulldev
fulldev --help
```

Add the agent skill, which tells an agent when and how to use the CLI:

```sh
npx skills add fulldotdev/cli
```

## Sign in

```sh
fulldev login               # once, for every app
fulldev status              # signed in, valid, email, organization, expiry
fulldev logout
```

`fulldev login` opens your browser at [app.full.dev](https://app.full.dev/sign-in), where you sign in with your Fulldev account, with a code sent to your email or with Google, and choose your organization when you are in more than one. Add `--no-browser` to only print the link.

On a computer without a browser, such as over SSH, run `fulldev login --no-browser` and open the link on your own computer. The page after sign-in does not load there, because it is meant for the computer that runs `fulldev`: copy its address from the address bar and paste it into the terminal.

One sign-in covers every app the organization gives you: the tokens are for the Fulldev MCP server, which checks on every call which apps you may use. When you are in more than one organization, you choose one at every sign-in; to switch organization, run `fulldev login` again.

`fulldev logout` revokes the refresh token at the authorization server (access tokens cannot be revoked and expire within 15 minutes) and deletes the tokens from this computer. When revoking fails, for example offline, it still deletes them and says so.

How it works:

- Browser sign-in uses OAuth with PKCE (S256) and a redirect to `http://127.0.0.1:<random port>/callback`, or the pasted address of that redirect, after checking that it belongs to this sign-in. It asks for the server's MCP URL as the resource, so the token is only valid there.
- The CLI is a public OAuth client that needs no registration: its client id is the address of its [Client ID Metadata Document](https://full.dev/oauth/cli.json), which the authorization server at `https://app.full.dev/api/auth` reads. It never registers a client, so sign-in to a server that does not support such documents fails with `CLIENT_METADATA_UNSUPPORTED`.
- Tokens are stored in the OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service on Linux) under the service `fulldev`, one entry per server. Where no keychain is available, such as in many containers and CI runners, they go to `~/.config/fulldev/auth.json` (or `$XDG_CONFIG_HOME/fulldev/auth.json`), readable only by you; `fulldev status` says which one is used.
- Access tokens are refreshed when they expire. Parallel commands take turns through a lock file next to it, so they never refresh the same token twice.
- Sign-ins from fulldev 0.3 and earlier were per app and made with Clerk, and no longer work: run `fulldev login` again.

Commands never start a sign-in without a terminal (when stdin or stdout is not a TTY): they fail at once with exit code 3 and say to run `fulldev login`. At a terminal they open the browser sign-in themselves; `--no-login` turns that off.

## Use

```sh
fulldev instructions                    # how to use every app you may use, from the server; read first
fulldev tools                           # name, title and description of every tool
fulldev call cms_list_repositories
fulldev cms instructions                # the overview and the CMS's own part
fulldev cms tools                       # the CMS's tools only
fulldev cms tools commit_files          # description, input schema, output schema, annotations
fulldev cms call read_file '{"branchId":"<id>","path":"src/content/home.md"}'
fulldev cms call commit_files --file changes.json
echo '{"branchId":"<id>"}' | fulldev cms call get_preview -
fulldev cms form wait <branchId> <formId> --timeout 60
fulldev help cms call                   # help for any command
```

After `fulldev <app>`, a tool's name may leave out the app's prefix: `fulldev cms call read_file` calls `cms_read_file`.

`call` prints the tool's result as JSON on stdout. When the tool fails, it prints the error on stderr and exits with 1.

`fulldev cms form wait` keeps calling `cms_wait_for_form` until the person sends the form, with a progress line on stderr each round, then prints the result. After `--timeout` minutes (default 30) it stops, also in the middle of a request, prints the form id, and exits with 2, so you can run it again.

## Output and exit codes

Data is JSON on stdout. `instructions` and help are plain text. Progress lines go to stderr. Every error, including a wrong command, is one JSON object on stderr:

```json
{
  "error": {
    "code": "SIGN_IN_REQUIRED",
    "message": "Not signed in to Fulldev. Run: fulldev login",
    "command": "fulldev login"
  }
}
```

| Code | Meaning                         |
| ---- | ------------------------------- |
| 0    | Done                            |
| 1    | Error, from the tool or the CLI |
| 2    | `form wait` timed out           |
| 3    | Sign-in needed                  |
| 64   | Usage error                     |

## Deploy previews

`--url <mcp url>` or `FULLDEV_URL` selects another server, such as a deploy preview's, which serves it at `/mcp`. Each server has its own sign-in.

```sh
FULLDEV_URL=https://deploy-preview-12--fulldev-app.netlify.app/mcp fulldev login
fulldev cms tools --url https://deploy-preview-12--fulldev-app.netlify.app/mcp
```

## Develop

```sh
pnpm install
pnpm check   # format, lint, type check, tests, and that dist/ is up to date
pnpm build   # writes dist/cli.mjs
```

An app is one entry in `src/apps.ts`; the server's address is `server` there. The OAuth client id is `clientMetadataUrl` in `src/oauth.ts`; the document at that address is published with the full.dev website.

`dist/` is committed, because `npx github:fulldotdev/cli` runs it without a build step. Run `pnpm build` and commit `dist/` with every source change.

## Releases

Every change that users get adds a changeset with `pnpm changeset`. The [`fulldev` package](https://www.npmjs.com/package/fulldev) is published only from [fulldotdev/cli](https://github.com/fulldotdev/cli): merging a change with its changeset to `main` opens a release pull request, and merging that publishes to npm from GitHub Actions with trusted publishing and provenance, without an npm token.

## License

[MIT](LICENSE)
