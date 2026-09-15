import { db, getAppCredentials, exchangeToken, syncStore, publicStore } from "../_lib.js";
import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).send("Paramètres manquants");

  const domain = shop.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const { clientId, clientSecret } = getAppCredentials();

  try {
    const token = await exchangeToken(domain, clientId, clientSecret, code);

    const supa = db();
    const { data: existing } = await supa.from("stores").select("id").eq("domain", domain).maybeSingle();

    if (existing) {
      await supa.from("stores").update({ token }).eq("id", existing.id);
      const store = { id: existing.id, domain, token };
      try {
        const data = await syncStore(store);
        await supa.from("stores").update({ data, error: null }).eq("id", existing.id);
      } catch (e) {
        await supa.from("stores").update({ error: e.message }).eq("id", existing.id);
      }
    } else {
      const store = { id: crypto.randomUUID(), domain, token, label: null, added_at: new Date().toISOString(), data: null, error: null };
      try { store.data = await syncStore(store); } catch (e) { store.error = e.message; }
      await supa.from("stores").insert(store);
    }

    res.writeHead(302, { Location: "/?connected=" + encodeURIComponent(domain) });
    res.end();
  } catch (e) {
    res.writeHead(302, { Location: "/?error=" + encodeURIComponent(e.message) });
    res.end();
  }
}
