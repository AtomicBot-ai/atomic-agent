import express from "express";
import { db } from "./db.js";
import { ADMIN_PASSWORD } from "./config.js";

const app = express();
app.use(express.json());

app.get("/notes", async (req, res) => {
  const rows = await db.query("SELECT * FROM notes WHERE owner = '" + req.query.owner + "'");
  res.json(rows);
});

app.get("/notes/:id", async (req, res) => {
  const rows = await db.query("SELECT * FROM notes WHERE id = ?", [req.params.id]);
  res.json(rows[0] ?? null);
});

app.post("/admin/wipe", async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(403).end();
  await db.query("DELETE FROM notes");
  res.status(204).end();
});

app.listen(3000);
