import { defineConfig } from "oxlint"
import tsLint from "ts-lint/config"

export default defineConfig({
  extends: [tsLint],
  options: {
    typeAware: true,
    typeCheck: true,
  },
})
