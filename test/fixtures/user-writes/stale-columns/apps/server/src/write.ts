declare const db: any, h: any;
export function narrow() { return db.update(h.schema.user).set({ name: "not-logged" }); }
