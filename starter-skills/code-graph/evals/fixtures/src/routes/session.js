import { verifyPassword } from "../auth/passwords.js";

export function registerSessionRoutes(router) {
  router.post("/login", async (req, res) => {
    const ok = await verifyPassword(req.body.email, req.body.password);
    res.status(ok ? 200 : 401).end();
  });
  router.post("/logout", (req, res) => res.status(204).end());
}
