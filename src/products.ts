import { UsageError } from "./errors.ts"

/** A Fulldev product with a remote MCP server. Add a product with one entry. */
export interface Product {
  name: string
  title: string
  url: string
  description: string
  /** Has the wait_for_form tool, so `fulldev <product> form wait` exists. */
  forms?: boolean
}

export const products: Array<Product> = [
  {
    name: "cms",
    title: "Fulldev CMS",
    url: "https://cms.full.dev/mcp",
    description:
      "Edit your website: text, pages, images and settings, through a pull request.",
    forms: true,
  },
  {
    name: "connect",
    title: "Fulldev Connect",
    url: "https://connect.full.dev/mcp",
    description:
      "Use your organization's business tools, such as Shopify, with the access Fulldev grants you.",
  },
  {
    name: "scan",
    title: "Fulldev Scan",
    url: "https://scan.full.dev/mcp",
    description: "Scan whole websites for problems. For administrators only.",
  },
  {
    name: "sites",
    title: "Fulldev Sites",
    url: "https://sites.full.dev/mcp",
    description:
      "Have Fulldev make a finished website from a brief and tested design options. For administrators only for now.",
  },
]

/** A product with the server URL this run uses. */
export interface Target extends Product {
  /** True when --url chose the server, so commands must repeat it. */
  urlFromFlag: boolean
}

export function findProduct(name: string): Product | undefined {
  return products.find((product) => product.name === name)
}

/** The environment variable that overrides a product's URL, such as FULLDEV_CMS_URL. */
export function urlVariable(product: Product) {
  return `FULLDEV_${product.name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_URL`
}

/** The product's server: --url, then FULLDEV_<PRODUCT>_URL, then the default. */
export function resolveTarget(
  product: Product,
  flagUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): Target {
  const url = flagUrl ?? env[urlVariable(product)] ?? product.url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`Not a valid server URL for ${product.name}: ${url}`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new UsageError(
      `The server URL for ${product.name} must use https: ${url}`,
    )
  return { ...product, url: parsed.href, urlFromFlag: flagUrl !== undefined }
}
