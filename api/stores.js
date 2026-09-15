import { db, checkAuth, readBody, syncStore, publicStore } from "./_lib.js";
import crypto from "crypto";

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const supa = db();

  if (req.method === "GET") {
    const { data, error } = await supa.from("stores").select("*").order("added_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data.map(publicStore));
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    let { domain, token, label } = body;
    if (!domain || !token) return res.status(400).json({ error: "domain et token requis" });
    domain = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!domain.includes(".")) domain += ".myshopify.com";
    token = token.trim();

    const { data: existing } = await supa.from("stores").select("id").eq("domain", domain).maybeSingle();
    if (existing) return res.status(409).json({ error: "Boutique déjà ajoutée" });

    const store = { id: crypto.randomUUID(), domain, token, label: label || null, added_at: new Date().toISOString(), data: null, error: null };
    try {
      store.data = await syncStore(store);
    } catch (e) {
      store.error = e.message;
      if (e.message === "TOKEN_INVALID") return res.status(401).json({ error: "Token invalide ou expiré" });
      if (e.message === "SHOP_NOT_FOUND") return res.status(404).json({ error: "Boutique introuvable — vérifiez le domaine" });
      if (e.message.startsWith("SCOPE_MISSING")) return res.status(403).json({ error: "Scopes manquants : read_shopify_payments_payouts, read_shopify_payments_accounts, read_shopify_payments_disputes, read_orders, read_products, write_products" });
    }
    const { error } = await supa.from("stores").insert(store);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(publicStore(store));
  }

  res.status(405).json({ error: "Method not allowed" });
}
