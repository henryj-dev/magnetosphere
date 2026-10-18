declare const db: any, h: any;
export const destructure = () => {
  const s = h.schema;
  const { user: u, account } = s;
  db.update(u).set({ emailVerified: true });
  db.delete(account);
  const { user } = h.schema;
  db.insert(user).values({ name: "not-logged" });
};
