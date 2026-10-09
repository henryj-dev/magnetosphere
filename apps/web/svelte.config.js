// SvelteKit SPA 모드 (계획서 3.1). 정적 파일로만 빌드해 Node(Hono)와 Workers 정적 자산에 같은 결과물을 올린다.
// 서버 기능은 쓰지 않는다 — API 는 전부 Hono(apps/server)다. 없는 경로는 index.html 이 받아 클라이언트에서 라우팅한다.
import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: true }),
  },
};
