import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "ormai": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@ormai/prisma": path.resolve(__dirname, "packages/prisma/src/index.ts"),
    },
  },
})
