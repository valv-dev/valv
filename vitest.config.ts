import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@valv/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@valv/prisma": path.resolve(__dirname, "packages/prisma/src/index.ts"),
      "@valv/clickhouse": path.resolve(__dirname, "packages/clickhouse/src/index.ts"),
    },
  },
})
