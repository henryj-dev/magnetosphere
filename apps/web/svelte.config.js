// SvelteKit SPA 모드 (계획서 3.1). 정적 파일로만 빌드해 Node(Hono)와 Workers 정적 자산에 같은 결과물을 올린다.
// 서버 기능은 쓰지 않는다 — API 는 전부 Hono(apps/server)다. 없는 경로는 index.html 이 받아 클라이언트에서 라우팅한다.
import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: true }),
    // 빌드가 넣는 인라인 부트스트랩 스크립트의 해시를 <meta> CSP 에 적는다. 스크립트·스타일은 자기 출처와 그 해시만 돈다.
    // frame-ancestors 처럼 <meta> 로 못 거는 지시어는 서버(apps/server, hono/secure-headers)가 응답 헤더로 건다 (TC-S4.T3.f).
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        // SvelteKit 라우트 안내 요소(svelte-announcer)가 실행 중에 style 속성을 단다. 스타일만 인라인을 허용한다
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "connect-src": ["self"],
        "object-src": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
      },
    },
  },
};
