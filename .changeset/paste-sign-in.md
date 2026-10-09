---
"fulldev": minor
---

Sign in over SSH: with `--no-browser`, paste the address of the page after sign-in into the terminal when the browser is on another computer. fulldev no longer registers an OAuth client itself and fails with `CLIENT_METADATA_UNSUPPORTED` on a server without Client ID Metadata Documents. It no longer removes the sign-in file of version 0.1.0; delete `~/.config/fulldev/credentials.json` if it is still there.
