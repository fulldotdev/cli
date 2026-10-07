# fulldev

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
