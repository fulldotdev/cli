# Fulldev CLI

Edit your website through the [Fulldev CMS](https://cms.full.dev) from a terminal or an AI agent. The CLI is a thin client of the CMS's MCP server: it reads the tools, their input schemas, and the instructions from the server each time, so it stays in step with the CMS.

## Install

Run it straight from GitHub. It needs Node.js 24 or later.

```sh
npx -y github:fulldotdev/cli help
pnpm dlx github:fulldotdev/cli help
```

Or install it once:

```sh
npm install -g github:fulldotdev/cli
fulldev help
```

Add the agent skill, which tells an agent when and how to use the CLI:

```sh
npx skills add fulldotdev/cli
```

## Sign in

```sh
fulldev login
```

This opens your browser to sign in with your Fulldev account and choose your organization. Any other command starts a sign-in too when you are not signed in; add `--no-login` to fail with exit code 3 instead, and `--no-browser` to only print the link.

```sh
fulldev status   # who is signed in, and whether the sign-in still works
fulldev logout   # forget the sign-in for this server
```

The sign-in uses OAuth with PKCE and a redirect to `127.0.0.1`. The CLI registers itself with the authorization server the first time. Tokens are saved in `~/.config/fulldev/credentials.json` (or `$XDG_CONFIG_HOME/fulldev/credentials.json`), readable only by you, per server, and refreshed when they expire.

## Use

```sh
fulldev instructions                  # how to use the tools, from the server
fulldev tools                         # name, title, and description of each tool
fulldev tools commit_files            # one tool's description and input schema
fulldev call list_projects
fulldev call read_file '{"branchId":"<id>","path":"src/content/home.md"}'
fulldev call commit_files --file changes.json
echo '{"branchId":"<id>"}' | fulldev call get_preview -
fulldev form wait <branchId> <formId> --timeout 60
```

`call` prints the tool's result as JSON on stdout. When the tool fails, it prints the error as JSON on stderr and exits with 1.

`form wait` keeps calling `wait_for_form` until the person sends the form, with a progress line on stderr each round, then prints the result. After `--timeout` minutes (default 30) it prints the form id and exits with 2, so you can run it again.

Exit codes: 0 done, 1 error, 2 form wait timed out, 3 sign-in needed.

## Other servers

`--url <mcp url>` or `FULLDEV_URL` selects another server, such as a deploy preview of the CMS. The default is `https://cms.full.dev/mcp`. Each server has its own sign-in.

```sh
FULLDEV_URL=https://deploy-preview-12--fulldev-cms.netlify.app/mcp fulldev login
```

## Develop

```sh
pnpm install
pnpm check   # format, lint, type check, and tests
pnpm build   # writes dist/cli.mjs
```

`dist/` is committed, because `npx github:fulldotdev/cli` runs it without a build step. Run `pnpm build` and commit `dist/` with every source change.

## License

[MIT](LICENSE)
