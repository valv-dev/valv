import { Valv } from "@valv/core"
import type { DefaultContext, InferResources, ValvConfig } from "@valv/core"
import type { PrismaClient } from "@prisma/client"
import { PrismaAdapter } from "./adapter"

type CreateConfig<TContext, TClient extends PrismaClient> = Omit<
  ValvConfig<TContext, InferResources<TClient>>,
  "adapter"
> & {
  schemaPath?: string
}

/**
 * Build a policy-gated valv instance over a Prisma client. Reads the schema from
 * the Prisma datasource (DMMF) on construction, so the returned instance is ready
 * to use — `await` it once at startup.
 */
export async function createValv<TClient extends PrismaClient, TContext = DefaultContext>(
  prisma: TClient,
  config?: CreateConfig<TContext, TClient>,
): Promise<Valv<TContext, InferResources<TClient>>> {
  const { schemaPath, ...rest } = config ?? {}
  const valv = new Valv<TContext, InferResources<TClient>>({
    ...rest,
    adapter: new PrismaAdapter(prisma, { schemaPath }),
  })
  await valv.loadSchema()
  return valv
}
