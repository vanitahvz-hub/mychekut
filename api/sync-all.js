import { db, checkAuth, syncStore, publicStore } from "./_lib.js";

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const supa = db();
  const { data: stores, error } = await supa.from("stores").select("*");
  if (error) return res.status(500).json({ error: error.message });

  await Promise.all(stores.map(async (s) => {
    try { s.data = await syncStore(s); s.error = null; }
    catch (e) { s.error = e.message; }
    await supa.from("stores").update({ data: s.data, error: s.error }).eq("id", s.id);
  }));
  res.json(stores.map(publicStore));
}
