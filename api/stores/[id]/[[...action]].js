import { db, checkAuth, readBody, syncStore, publicStore, shopifyGraphQL } from "../../_lib.js";

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const { id, action } = req.query;
  const supa = db();

  const { data: store, error: e0 } = await supa.from("stores").select("*").eq("id", id).maybeSingle();
  if (e0) return res.status(500).json({ error: e0.message });
  if (!store) return res.status(404).json({ error: "Boutique introuvable" });

  if (action === "sync" && req.method === "POST") {
    try { store.data = await syncStore(store); store.error = null; }
    catch (e) {
      store.error = e.message;
      if (store.data) store.data.health = { status: "blocked", alerts: [{ level: "critical", code: e.message, msg: e.message }] };
    }
    await supa.from("stores").update({ data: store.data, error: store.error }).eq("id", id);
    return res.json(publicStore(store));
  }

  if (action === "products" && req.method === "GET") {
    const q = `{ products(first: 25, reverse: true, sortKey: CREATED_AT) { edges { node { id title handle status variants(first:1){edges{node{legacyResourceId price}}} } } } }`;
    try {
      const d = await shopifyGraphQL(store.domain, store.token, q);
      const primary = store.data?.primaryUrl?.replace(/\/$/, "") || `https://${store.domain}`;
      return res.json(d.products.edges.map((e) => {
        const v = e.node.variants.edges[0]?.node;
        return { id: e.node.id, title: e.node.title, handle: e.node.handle, status: e.node.status, price: v?.price, variantId: v?.legacyResourceId, paymentLink: v ? `${primary}/cart/${v.legacyResourceId}:1` : null };
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === "product" && req.method === "POST") {
    const { title, price, description, quantity } = await readBody(req);
    if (!title || !price) return res.status(400).json({ error: "title et price requis" });
    const mutation = `mutation C($input: ProductInput!){ productCreate(input:$input){ product{ id title handle onlineStoreUrl variants(first:1){edges{node{legacyResourceId}}} } userErrors{message} } }`;
    try {
      const d = await shopifyGraphQL(store.domain, store.token, mutation, {
        input: { title, descriptionHtml: description || "", status: "ACTIVE", variants: [{ price: String(price), inventoryPolicy: "CONTINUE" }] },
      });
      const errs = d.productCreate.userErrors;
      if (errs?.length) return res.status(400).json({ error: errs.map((x) => x.message).join("; ") });
      const p = d.productCreate.product;
      const vid = p.variants.edges[0]?.node.legacyResourceId;
      const qty = Math.max(1, parseInt(quantity) || 1);
      const primary = store.data?.primaryUrl?.replace(/\/$/, "") || `https://${store.domain}`;
      return res.json({
        product: { id: p.id, title: p.title, handle: p.handle, variantId: vid, price },
        paymentLink: `${primary}/cart/${vid}:${qty}`,
        productUrl: p.onlineStoreUrl || `${primary}/products/${p.handle}`,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (!action && req.method === "PATCH") {
    const b = await readBody(req);
    const upd = {};
    if (b.label !== undefined) upd.label = b.label;
    if (b.token) upd.token = b.token.trim();
    await supa.from("stores").update(upd).eq("id", id);
    const { data: s2 } = await supa.from("stores").select("*").eq("id", id).maybeSingle();
    return res.json(publicStore(s2));
  }

  if (!action && req.method === "DELETE") {
    await supa.from("stores").delete().eq("id", id);
    return res.json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}
