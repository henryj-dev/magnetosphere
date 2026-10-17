-- 0006 손으로 쓴 데이터 마이그레이션 (M6 후속 U1 소급). 스키마는 바꾸지 않는다.
-- 이미 삭제한 회원(status = 'deleted')이 수락한 초대의 email 을 user 와 같은 익명값으로 바꾼다. used_by 는 남긴다.
UPDATE "invites" SET "email" = 'deleted-' || "used_by" || '@invalid' WHERE "email" IS NOT NULL AND "used_by" IN (SELECT "id" FROM "user" WHERE "status" = 'deleted');