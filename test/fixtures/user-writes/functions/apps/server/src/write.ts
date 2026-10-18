declare const db: any, h: any;
export const handlers = {
  async method() { db.update(h.schema.user).set({ status: "active" }); },
  arrow: () => db.insert(h.schema.user).values({ name: "not-logged" }),
};
export class Writer {
  method() { return db.delete(h.schema.user); }
}
