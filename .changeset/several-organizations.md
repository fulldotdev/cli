---
"fulldev": minor
---

Work in several organizations with one sign-in. `fulldev login` lets you tick the organizations to grant, all of yours at first, instead of choosing one; a call names its organization with `--org <slug>`, and `--all-orgs` calls a tool that only reads in every organization that has its app. `fulldev status` lists the organizations with their slugs and apps under `organizations`, instead of `organizationId`. Sign-in waits up to 10 minutes instead of 5, and `fulldev login <app>` says to run `fulldev login` without the app.
