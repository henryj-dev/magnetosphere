import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// 개발 서버에서 /api 는 apps/server(Node, 기본 3000)로 넘긴다
export default defineConfig({
  plugins: [sveltekit()],
  server: { proxy: { "/api": "http://localhost:3000", "/healthz": "http://localhost:3000" } },
});
