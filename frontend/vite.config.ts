import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The back office API (backend/) during development
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  test: {
    include: ["test/**/*.test.tsx"],
    environment: "node",
  },
});
