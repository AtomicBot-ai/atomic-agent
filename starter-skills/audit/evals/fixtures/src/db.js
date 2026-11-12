export const db = {
  async query(sql, params = []) {
    return [{ sql, params }];
  },
};
