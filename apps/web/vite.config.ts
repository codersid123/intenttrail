import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Requests to /api/... are forwarded to the Express server
    proxy: { "/api": "http://localhost:4000" },
  },
});
