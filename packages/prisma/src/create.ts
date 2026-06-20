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

export function createValv<TClient extends PrismaClient, TContext = DefaultContext>(
  prisma: TClient,
  config?: CreateConfig<TContext, TClient>,
): Valv<TContext, InferResources<TClient>> {
  const { schemaPath, ...rest } = config ?? {}
  return new Valv<TContext, InferResources<TClient>>({
    ...rest,
    adapter: new PrismaAdapter(prisma, { schemaPath }),
  })
}
