export const gateway = {
  async post(path, body) {
    return { ok: true, path, body };
  },
};
