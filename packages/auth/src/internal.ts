export interface SelfDeleteCredentialProof {
  authVersion: number;
  accountId: string;
  /** 서버 내부 CAS proof. HTTP·JSON·logger·오류 cause에 넣지 않는다. */
  passwordHash: string;
  /** DB session.credentialFingerprint 원값. NULL을 현재 HMAC으로 바꾸지 않는다. T2 CAS는 NULL이면 IS NULL, string이면 동등 비교. */
  observedSessionFingerprint: string | null;
  /** 현재 credential의 HMAC. 저장된 NULL fingerprint를 이 값으로 재바인딩하지 않는다. */
  currentCredentialFingerprint: string;
}

export interface SelfDeleteCredentialProofInput {
  userId: string;
  sessionId: string;
  password: string;
}
export type SelfDeleteCredentialProve = (input: SelfDeleteCredentialProofInput) => Promise<SelfDeleteCredentialProof | null>;

const selfDeleteProofs = new WeakMap<object, SelfDeleteCredentialProve>();

/** createAuth의 원본 반환 객체에만 등록한다. spread 사본으로는 조회하지 않는다. */
export function bindSelfDeleteProof(auth: object, prove: SelfDeleteCredentialProve): void {
  if (selfDeleteProofs.has(auth)) throw new Error("Self-delete proof is already registered");
  selfDeleteProofs.set(auth, prove);
}

export function selfDeleteCredentialProofOf(auth: object): SelfDeleteCredentialProve {
  const prove = selfDeleteProofs.get(auth);
  if (!prove) throw new Error("Self-delete proof is not registered");
  return prove;
}
