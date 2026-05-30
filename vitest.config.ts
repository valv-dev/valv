import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@vista/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@vista/prisma": path.resolve(__dirname, "packages/prisma/src/index.ts"),
    },
  },
})
