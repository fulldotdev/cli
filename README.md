# Fulldev CLI

Use Fulldev products from a terminal or an AI agent. The CLI is a thin client of each product's MCP server: it reads the tools, their schemas, and the instructions from the server each time, so it stays in step with the product.

| Product   | Server                         | For                                                                                       |
| --------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `cms`     | `https://cms.full.dev/mcp`     | Editing your website through the [Fulldev CMS](https://cms.full.dev)                      |
| `connect` | `https://connect.full.dev/mcp` | Your business tools, such as Shopify, through [Fulldev Connect](https://connect.full.dev) |
| `scan`    | `https://scan.full.dev/mcp`    | Scanning websites with [Fulldev Scan](https://scan.full.dev), for administrators only     |

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
fulldev login               # every product, one after the other
fulldev login cms           # one product
fulldev status              # per product: signed in, valid, email, organization, expiry
fulldev logout              # every product
fulldev logout cms          # one product
```

`fulldev login` opens your browser to sign in with your Fulldev account and choose your organization. Add `--no-browser` to only print the link.

There is one Fulldev account for all products, but each product gets its own tokens, which only that product accepts. The browser remembers your account, so signing in to the next product is quick. The organization is chosen at sign-in; to switch organization, run `fulldev login <product>` again.

`fulldev logout` revokes the product's refresh token at the authorization server (access tokens cannot be revoked and expire within a day) and deletes them from this computer. When revoking fails, for example offline, it still deletes them and says so.

How it works:

- Browser sign-in uses OAuth with PKCE (S256) and a redirect to `http://127.0.0.1:<random port>/callback`. It asks for the product's MCP URL as the resource, so the token is only valid for that product.
- The CLI is a pre-registered public OAuth client of [Clerk](https://clerk.full.dev). For another authorization server, such as the Clerk development instance behind a deploy preview, it registers a client itself the first time.
- Tokens are stored in the OS keychain (macOS Keychain, Windows Credential Manager, or the Secret Service on Linux) under the service `fulldev`, one entry per product server. Where no keychain is available, such as in many containers and CI runners, they go to `~/.config/fulldev/auth.json` (or `$XDG_CONFIG_HOME/fulldev/auth.json`), readable only by you; `fulldev status` says which one is used.
- Access tokens are refreshed when they expire. Parallel commands take turns through a lock file next to it, so they never refresh the same token twice.
- Version 0.1.0 kept a sign-in for the CMS in `~/.config/fulldev/credentials.json`. The first command of this version removes that file and asks you to sign in again with `fulldev login cms`.

Product commands never start a sign-in without a terminal (when stdin or stdout is not a TTY): they fail at once with exit code 3 and say which `fulldev login <product>` to run. At a terminal they open the browser sign-in themselves; `--no-login` turns that off.

## Use

```sh
fulldev cms instructions                # how to use the tools, from the server; read first
fulldev cms tools                       # name, title and description of each tool
fulldev cms tools commit_files          # description, input schema, output schema, annotations
fulldev cms call list_projects
fulldev cms call read_file '{"branchId":"<id>","path":"src/content/home.md"}'
fulldev cms call commit_files --file changes.json
echo '{"branchId":"<id>"}' | fulldev cms call get_preview -
fulldev cms form wait <branchId> <formId> --timeout 60
fulldev connect tools
fulldev help cms call                   # help for any command
```

`call` prints the tool's result as JSON on stdout. When the tool fails, it prints the error on stderr and exits with 1.

`fulldev cms form wait` keeps calling `wait_for_form` until the person sends the form, with a progress line on stderr each round, then prints the result. After `--timeout` minutes (default 30) it stops, also in the middle of a request, prints the form id, and exits with 2, so you can run it again.

## Output and exit codes

Data is JSON on stdout. `instructions` and help are plain text. Progress lines go to stderr. Every error, including a wrong command, is one JSON object on stderr:

```json
{
  "error": {
    "code": "SIGN_IN_REQUIRED",
    "message": "Not signed in to Fulldev CMS. Run: fulldev login cms",
    "command": "fulldev login cms"
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

`--url <mcp url>` or `FULLDEV_<PRODUCT>_URL` (such as `FULLDEV_CMS_URL` or `FULLDEV_CONNECT_URL`) selects another server for one product. Each server has its own sign-in.

```sh
FULLDEV_CMS_URL=https://deploy-preview-12--fulldev-cms.netlify.app/mcp fulldev login cms
fulldev cms tools --url https://deploy-preview-12--fulldev-cms.netlify.app/mcp
```

## Develop

```sh
pnpm install
pnpm check   # format, lint, type check, tests, and that dist/ is up to date
pnpm build   # writes dist/cli.mjs
```

A product is one entry in `src/products.ts`. The pre-registered OAuth client ids are in `clientIds` in `src/oauth.ts`.

`dist/` is committed, because `npx github:fulldotdev/cli` runs it without a build step. Run `pnpm build` and commit `dist/` with every source change.

## Releases

Every pull request that changes what users get adds a changeset with `pnpm changeset`. Merging to `main` opens a release pull request; merging that publishes the [`fulldev` package](https://www.npmjs.com/package/fulldev) to npm from GitHub Actions with trusted publishing and provenance, without an npm token. `dist/` stays committed, so `npx github:fulldotdev/cli` keeps working; `pnpm check` fails when it is out of date.

## License

[MIT](LICENSE)
