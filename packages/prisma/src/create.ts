import { Vista } from "@vista/core"
import type { DefaultContext, InferResources, VistaConfig } from "@vista/core"
import type { PrismaClient } from "@prisma/client"
import { PrismaAdapter } from "./adapter"

type CreateConfig<TContext, TClient extends PrismaClient> =
  Omit<VistaConfig<TContext, InferResources<TClient>>, "adapter"> & {
    schemaPath?: string
  }

export function createVista<TClient extends PrismaClient, TContext = DefaultContext>(
  prisma: TClient,
  config?: CreateConfig<TContext, TClient>
): Vista<TContext, InferResources<TClient>> {
  const { schemaPath, ...rest } = config ?? {}
  return new Vista<TContext, InferResources<TClient>>({
    ...rest,
    adapter: new PrismaAdapter(prisma, schemaPath),
  })
}
