import { describe, it, expect } from "vitest";
import { makeApp, PRIV, DEFAULTS, pick } from "./app.mjs";

describe("V17 권한 칼럼 입력 차단", () => {
  it("TC-S1.T4.a input:false 면 가입·수정 본문의 권한 값이 무시되거나 거부된다", async () => {
    const app = await makeApp(true);

    // 1) 권한 값을 실은 가입
    const su = await app.call("/sign-up/email", { email: "eve@x.test", password: "evepass1234", name: "Eve", ...PRIV });
    console.log("[a] sign-up", su.status, JSON.stringify(su.json)?.slice(0, 200));
    if (su.status === 200) {
      expect(pick(app.row("eve@x.test"))).toEqual(DEFAULTS);
    } else {
      // 거부라면 계정이 아예 없어야 한다. 그 뒤 정상 가입으로 update-user 를 검사한다.
      expect(app.row("eve@x.test")).toBeUndefined();
      const ok = await app.call("/sign-up/email", { email: "eve@x.test", password: "evepass1234", name: "Eve" });
      expect(ok.status).toBe(200);
    }
    expect(pick(app.row("eve@x.test"))).toEqual(DEFAULTS);

    // 1-b) 가입 본문에 칼럼 하나씩: 각각 거부되거나, 받아들여져도 기본값이어야 한다
    for (const [i, [k, v]] of Object.entries(PRIV).entries()) {
      const email = `eve${i}@x.test`;
      const r = await app.call("/sign-up/email", { email, password: "evepass1234", name: "Eve", [k]: v });
      console.log("[a] sign-up", k, r.status, r.json?.code ?? "");
      if (r.status === 200) expect(pick(app.row(email))).toEqual(DEFAULTS);
      else expect(app.row(email)).toBeUndefined();
    }

    // 2) 로그인 세션으로 update-user 에 권한 값
    const up = await app.call("/update-user", { name: "Eve2", ...PRIV });
    console.log("[a] update-user", up.status, JSON.stringify(up.json)?.slice(0, 200));
    expect([200, 400]).toContain(up.status);
    expect(pick(app.row("eve@x.test"))).toEqual(DEFAULTS);

    // 3) 칼럼 하나씩 따로 넣어도 마찬가지 (한 필드 거부가 다른 필드를 가리는지 확인)
    for (const [k, v] of Object.entries(PRIV)) {
      const r = await app.call("/update-user", { [k]: v });
      console.log("[a] update-user", k, r.status);
      expect(pick(app.row("eve@x.test"))).toEqual(DEFAULTS);
    }
  });

  it("TC-S1.T4.b 대조군: input 미지정이면 값이 들어간다", async () => {
    const app = await makeApp(false);
    const su = await app.call("/sign-up/email", { email: "eve@x.test", password: "evepass1234", name: "Eve", ...PRIV });
    console.log("[b] sign-up", su.status, JSON.stringify(pick(app.row("eve@x.test"))));
    expect(su.status).toBe(200);
    expect(app.row("eve@x.test").role).toBe("admin");
    expect(pick(app.row("eve@x.test"))).toEqual({ ...PRIV, is_bootstrap_admin: 1 });

    // 수정 경로도 열려 있는지: 값을 바꿔 다시 넣는다
    const up = await app.call("/update-user", { role: "owner", max_keys: 5 });
    console.log("[b] update-user", up.status, JSON.stringify(pick(app.row("eve@x.test"))));
    expect(up.status).toBe(200);
    expect(app.row("eve@x.test").role).toBe("owner");
    expect(app.row("eve@x.test").max_keys).toBe(5);
  });
});
