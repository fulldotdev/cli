# fulldev

## 0.5.0

### Minor Changes

- [#12](https://github.com/fulldotdev/cli/pull/12) [`e9ef0a1`](https://github.com/fulldotdev/cli/commit/e9ef0a14b16bfffea2211becc6bf9179ee9f67b1) Thanks [@silveltman](https://github.com/silveltman)! - Work in several organizations with one sign-in. `fulldev login` lets you tick the organizations to grant, all of yours at first, instead of choosing one; a call names its organization with `--org <slug>`, and `--all-orgs` calls a tool that only reads in every organization that has its app. `fulldev status` lists the organizations with their slugs and apps under `organizations`, instead of `organizationId`. Sign-in waits up to 10 minutes instead of 5, and `fulldev login <app>` says to run `fulldev login` without the app.

## 0.4.0

### Minor Changes

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Sign in through Fulldev's own account pages at `https://app.full.dev`; existing sign-ins must sign in again.

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Fulldev's products are now called apps. The help lists them under "Apps" and reads `fulldev <app> <command>`, and the JSON of `fulldev status`, `fulldev logout` and a sign-in error names each one as `app` (a list under `apps`) instead of `product` (`products`). Commands, names and servers stay the same.

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Add Fulldev Contacts as the app `contacts`: check, pause and resume the daily copy of your Google contacts, and answer its look-alike questions.

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Every app through one Fulldev MCP server, at `https://app.full.dev/mcp`, with one sign-in. `fulldev login`, `fulldev status` and `fulldev logout` no longer take an app, and `status` and `logout` print that one sign-in as one object instead of a list under `apps`; a sign-in error names `fulldev login`. Each app's tools start with its name, such as `cms_list_repositories`. `fulldev instructions`, `fulldev tools` and `fulldev call` work across every app you may use; `fulldev <app> instructions|tools|call` show and call that app's part, with tool names with or without its prefix. `FULLDEV_URL` replaces `FULLDEV_<APP>_URL`.

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Add Fulldev Pages as the app `pages`.

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Sign in over SSH: with `--no-browser`, paste the address of the page after sign-in into the terminal when the browser is on another computer. fulldev no longer registers an OAuth client itself and fails with `CLIENT_METADATA_UNSUPPORTED` on a server without Client ID Metadata Documents. It no longer removes the sign-in file of version 0.1.0; delete `~/.config/fulldev/credentials.json` if it is still there.

### Patch Changes

- [#10](https://github.com/fulldotdev/cli/pull/10) [`acb41d5`](https://github.com/fulldotdev/cli/commit/acb41d5eb33461e377e1d282740b5594125a2184) Thanks [@silveltman](https://github.com/silveltman)! - Access tokens now last 15 minutes; the help of `fulldev logout` says so.

## 0.3.0

### Minor Changes

- [#8](https://github.com/fulldotdev/cli/pull/8) [`2da0656`](https://github.com/fulldotdev/cli/commit/2da065689653edac1b0faf99deea2080e8f0587f) Thanks [@silveltman](https://github.com/silveltman)! - Add Fulldev Sites as the product `sites`, at `https://sites.full.dev/mcp`: have Fulldev make a finished website from a brief and tested design options. For administrators only for now.

## 0.2.1

### Patch Changes

- [#6](https://github.com/fulldotdev/cli/pull/6) [`84519ee`](https://github.com/fulldotdev/cli/commit/84519eece137d4815fdc0f2a044ff0d9cbb2327d) Thanks [@silveltman](https://github.com/silveltman)! - Show the page after sign-in in the Fulldev colours, with the logo tile.

## 0.2.0

### Minor Changes

- [#2](https://github.com/fulldotdev/cli/pull/2) [`c8d2b2b`](https://github.com/fulldotdev/cli/commit/c8d2b2bc6891a449d51c2ffbeac7a82f4e2992b5) Thanks [@silveltman](https://github.com/silveltman)! - Work with every Fulldev product, and sign in per product with tokens in the OS keychain.

  Breaking: commands now start with the product. `fulldev tools`, `fulldev call`, `fulldev instructions` and `fulldev form wait` are now `fulldev cms tools`, `fulldev cms call`, `fulldev cms instructions` and `fulldev cms form wait`, and the same commands work for `connect` and `scan`. `FULLDEV_URL` is replaced by `FULLDEV_CMS_URL`, `FULLDEV_CONNECT_URL` and `FULLDEV_SCAN_URL`. The old commands are gone.

  - `fulldev login [product...]`, `fulldev logout [product...]` and `fulldev status` work per product, for all products by default.
  - Sign-in uses Fulldev's pre-registered OAuth client, and each token is only valid for its product. Logout revokes the refresh token.
  - Tokens are stored in the OS keychain, with a private file only where no keychain is available. The sign-in from 0.1.0 is removed; run `fulldev login cms` once.
  - Without a terminal, commands never start a sign-in: they exit with 3 and name the login to run.
  - Every error, including a wrong command, is one JSON object on stderr. A wrong command exits with 64. `--help` works for every command, and `fulldev <product> tools <name>` also shows the output schema and annotations.
  - `fulldev cms form wait` stops at its timeout also in the middle of a request.
