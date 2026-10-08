import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { core: "src/core/index.ts", next: "src/next.ts", node: "src/node.ts", form: "src/form.ts", testing: "src/testing.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    external: ["next", "next/server"],
    /* Inlined so plain Node ESM needs no JSON import attribute. */
    noExternal: ["disposable-email-domains"],
    target: "node20",
  },
  { entry: { "form.iife": "src/form-iife.ts" }, format: ["iife"], outExtension: () => ({ js: ".js" }), minify: true, target: "es2019" },
])
