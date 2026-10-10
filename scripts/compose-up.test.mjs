// compose-up.mjs 재현. main 62e0ba7 CI 의 G-K4.6 은 테스트를 돌기 전에 test:db 가 mysql:8.0 등을 받다가
// 레지스트리에서 "received unexpected HTTP status: 502 Bad Gateway" 를 한 번 받고 바로 실패했다.
// 가짜 docker 가 처음 n 번은 그 오류로 실패하고 그다음은 성공한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { composeUp } from "./compose-up.mjs";

function fakeDocker(failFirst) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-up-test-"));
  const calls = path.join(dir, "calls");
  const bin = path.join(dir, "docker");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> "${calls}"\nn=$(wc -l < "${calls}")\nif [ "$n" -le ${failFirst} ]; then echo "received unexpected HTTP status: 502 Bad Gateway" >&2; exit 1; fi\nexit 0\n`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : []) };
}

test("레지스트리가 한 번 502 를 줘도 다시 띄워 성공한다", () => {
  const d = fakeDocker(1);
  const r = composeUp("/x/compose.yml", ["mysql", "postgres"], { docker: d.bin, waitMs: [0] });
  assert.equal(r.status, 0);
  assert.deepEqual(d.calls(), ["compose -f /x/compose.yml up -d --wait mysql postgres", "compose -f /x/compose.yml up -d --wait mysql postgres"]);
});

test("계속 실패하면 정해진 횟수만 시도하고 실패를 돌려준다 (음성 대조)", () => {
  const d = fakeDocker(99);
  const r = composeUp("/x/compose.yml", ["mysql"], { docker: d.bin, tries: 3, waitMs: [0] });
  assert.equal(r.status, 1);
  assert.equal(d.calls().length, 3);
});

test("처음에 성공하면 한 번만 부른다", () => {
  const d = fakeDocker(0);
  assert.equal(composeUp("/x/compose.yml", [], { docker: d.bin, waitMs: [0] }).status, 0);
  assert.equal(d.calls().length, 1);
});
