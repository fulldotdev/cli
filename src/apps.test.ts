import { describe, expect, it } from "vite-plus/test"

import { parseCommandLine } from "./args.ts"
import { UsageError } from "./errors.ts"
import { apps, findApp, resolveTarget, server, toolName } from "./apps.ts"

describe("apps", () => {
  it("has cms, connect, scan, sites, pages and contacts on the one server", () => {
    expect(apps.map(({ name }) => name)).toEqual([
      "cms",
      "connect",
      "scan",
      "sites",
      "pages",
      "contacts",
    ])
    expect(server.url).toBe("https://app.full.dev/mcp")
    for (const app of apps) {
      expect(app.title).toMatch(/^Fulldev /)
      expect(app.description).not.toContain("\n")
    }
  })

  it("gives a tool the app's prefix unless it has it", () => {
    const cms = findApp("cms")!
    expect(toolName(cms, "list_repositories")).toBe("cms_list_repositories")
    expect(toolName(cms, "cms_list_repositories")).toBe("cms_list_repositories")
  })

  it("takes the server from --url, then FULLDEV_URL, then app.full.dev", () => {
    const preview = "https://deploy-preview-1--fulldev-app.netlify.app/mcp"
    const other = "https://other.example.com/mcp"
    expect(resolveTarget(undefined, {})).toEqual({
      title: "Fulldev",
      url: server.url,
      urlFromFlag: false,
    })
    expect(resolveTarget(undefined, { FULLDEV_URL: preview })).toMatchObject({
      url: preview,
      urlFromFlag: false,
    })
    expect(resolveTarget(other, { FULLDEV_URL: preview })).toMatchObject({
      url: other,
      urlFromFlag: true,
    })
    expect(
      parseCommandLine(["cms", "tools"], { FULLDEV_URL: preview }),
    ).toMatchObject({ target: { url: preview } })
  })

  it("rejects a URL that is not http or https", () => {
    expect(() => resolveTarget("file:///etc/passwd", {})).toThrow(UsageError)
    expect(() => resolveTarget(undefined, { FULLDEV_URL: "nope" })).toThrow(
      UsageError,
    )
  })
})
