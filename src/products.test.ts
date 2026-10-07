import { describe, expect, it } from "vite-plus/test"

import { parseCommandLine } from "./args.ts"
import { UsageError } from "./errors.ts"
import {
  findProduct,
  products,
  resolveTarget,
  urlVariable,
} from "./products.ts"

const cms = findProduct("cms")!

describe("products", () => {
  it("has cms, connect, scan and sites with their MCP servers", () => {
    expect(products.map(({ name, url }) => [name, url])).toEqual([
      ["cms", "https://cms.full.dev/mcp"],
      ["connect", "https://connect.full.dev/mcp"],
      ["scan", "https://scan.full.dev/mcp"],
      ["sites", "https://sites.full.dev/mcp"],
    ])
    for (const product of products) {
      expect(product.title).toMatch(/^Fulldev /)
      expect(product.description).not.toContain("\n")
    }
  })

  it("names the URL variable after the product", () => {
    expect(urlVariable(cms)).toBe("FULLDEV_CMS_URL")
    expect(urlVariable({ ...cms, name: "my-product" })).toBe(
      "FULLDEV_MY_PRODUCT_URL",
    )
  })

  it("takes the server from --url, then the variable, then the default", () => {
    const preview = "https://deploy-preview-1--cms.netlify.app/mcp"
    const other = "https://other.example.com/mcp"
    expect(resolveTarget(cms, undefined, {})).toMatchObject({
      url: cms.url,
      urlFromFlag: false,
    })
    expect(
      resolveTarget(cms, undefined, { FULLDEV_CMS_URL: preview }),
    ).toMatchObject({ url: preview, urlFromFlag: false })
    expect(
      resolveTarget(cms, other, { FULLDEV_CMS_URL: preview }),
    ).toMatchObject({ url: other, urlFromFlag: true })
  })

  it("applies a product's variable only to that product", () => {
    const env = { FULLDEV_CMS_URL: "https://preview.example.com/mcp" }
    const status = parseCommandLine(["status"], env)
    expect(
      "targets" in status && status.targets.map((target) => target.url),
    ).toEqual([
      "https://preview.example.com/mcp",
      "https://connect.full.dev/mcp",
      "https://scan.full.dev/mcp",
      "https://sites.full.dev/mcp",
    ])
    expect(parseCommandLine(["connect", "tools"], env)).toMatchObject({
      target: { url: "https://connect.full.dev/mcp" },
    })
  })

  it("applies --url to the named product", () => {
    expect(
      parseCommandLine(
        ["login", "connect", "--url", "https://p.example/mcp"],
        {},
      ),
    ).toMatchObject({
      targets: [
        { name: "connect", url: "https://p.example/mcp", urlFromFlag: true },
      ],
    })
  })

  it("rejects a URL that is not http or https", () => {
    expect(() => resolveTarget(cms, "file:///etc/passwd", {})).toThrow(
      UsageError,
    )
    expect(() =>
      resolveTarget(cms, undefined, { FULLDEV_CMS_URL: "nope" }),
    ).toThrow(UsageError)
  })
})
