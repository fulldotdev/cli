#!/usr/bin/env node
import { CredentialStore } from "./credentials.ts"
import { main } from "./main.ts"

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env: process.env,
  store: new CredentialStore(),
})
