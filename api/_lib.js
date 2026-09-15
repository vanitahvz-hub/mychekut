import { createClient } from "@supabase/supabase-js";

const API_VERSION = "2024-01";

export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY manquants dans les variables Vercel");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- Auth ----
export function checkAuth(req, res) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  const got = req.headers["x-app-password"] || "";
  if (got !== expected) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

export function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

// ---- Shopify ----
export async function shopifyGraphQL(domain, token, query, variables = {}) {
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401 || r.status === 403) throw new Error("TOKEN_INVALID");
  if (r.status === 402) throw new Error("SHOP_FROZEN");
  if (r.status === 423) throw new Error("SHOP_LOCKED");
  if (r.status === 404) throw new Error("SHOP_NOT_FOUND");
  if (!r.ok) throw new Error(`HTTP_${r.status}`);
  const j = await r.json();
  if (j.errors) {
    const msg = j.errors.map((e) => e.message).join("; ");
    if (/access denied|not approved|scope/i.test(msg)) throw new Error("SCOPE_MISSING: " + msg);
    throw new Error(msg);
  }
  return j.data;
}

export async function shopifyREST(domain, token, endpoint) {
  const url = `https://${domain}/admin/api/${API_VERSION}/${endpoint}`;
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
  if (!r.ok) throw new Error(`HTTP_${r.status}`);
  return r.json();
}

export const FULL_QUERY = `
{
  shop {
    name myshopifyDomain email createdAt currencyCode ianaTimezone
    plan { displayName partnerDevelopment shopifyPlus }
    primaryDomain { url host }
    billingAddress { country countryCodeV2 }
  }
  shopifyPaymentsAccount {
    id activated onboardable country defaultCurrency payoutStatementDescriptor
    balance { amount currencyCode }
    payoutSchedule { interval monthlyAnchor weeklyAnchor }
    bankAccounts(first: 10) { edges { node { id bankName accountNumberLastDigits currency country status createdAt } } }
    payouts(first: 60, reverse: true) {
      edges { node { id legacyResourceId issuedAt status transactionType
        net { amount currencyCode }
        summary { chargesGross { amount } chargesFee { amount } }
        bankAccount { bankName accountNumberLastDigits } } }
    }
    disputes(first: 10, reverse: true) {
      edges { node { id status reasonDetails { reason } amount { amount currencyCode } evidenceDueBy initiatedAt } }
    }
  }
  orders(first: 1, reverse: true, sortKey: CREATED_AT) { edges { node { createdAt } } }
}`;

function analyzeHealth(data, restShop) {
  const alerts = [];
  const sp = data.shopifyPaymentsAccount;
  let status = "healthy";
  if (!sp) {
    alerts.push({ level: "critical", code: "NO_SHOPIFY_PAYMENTS", msg: "Shopify Payments n'est pas activé" });
    status = "blocked";
  } else {
    if (!sp.activated) { alerts.push({ level: "critical", code: "NOT_ACTIVATED", msg: "Compte Shopify Payments non activé" }); status = "blocked"; }
    const banks = sp.bankAccounts?.edges?.map((e) => e.node) || [];
    if (banks.length === 0) { alerts.push({ level: "critical", code: "NO_BANK", msg: "Aucun compte bancaire relié" }); if (status === "healthy") status = "warning"; }
    for (const b of banks) {
      if (b.status === "ERRORED") { alerts.push({ level: "critical", code: "BANK_ERROR", msg: `Compte ${b.bankName} ····${b.accountNumberLastDigits} en erreur` }); status = "blocked"; }
      else if (b.status === "NEW") { alerts.push({ level: "warning", code: "BANK_UNVERIFIED", msg: `Compte ${b.bankName} ····${b.accountNumberLastDigits} pas encore vérifié` }); if (status === "healthy") status = "warning"; }
    }
    const payouts = sp.payouts?.edges?.map((e) => e.node) || [];
    const failed = payouts.filter((p) => p.status === "FAILED");
    if (failed.length > 0) { alerts.push({ level: "critical", code: "PAYOUT_FAILED", msg: `${failed.length} versement(s) échoué(s)` }); status = "blocked"; }
    const disputes = sp.disputes?.edges?.map((e) => e.node) || [];
    const open = disputes.filter((d) => ["NEEDS_RESPONSE", "UNDER_REVIEW"].includes(d.status));
    if (open.length > 0) { alerts.push({ level: "warning", code: "DISPUTES", msg: `${open.length} litige(s) ouvert(s)` }); if (status === "healthy") status = "warning"; }
    if (sp.payoutSchedule?.interval === "MANUAL") alerts.push({ level: "info", code: "MANUAL_PAYOUT", msg: "Versements manuels" });
  }
  const plan = restShop?.plan_name || data.shop?.plan?.displayName || "";
  if (/frozen|paused|fraudulent|cancelled/i.test(plan)) { alerts.push({ level: "critical", code: "SHOP_FROZEN", msg: `Boutique ${plan}` }); status = "blocked"; }
  if (restShop?.password_enabled) alerts.push({ level: "info", code: "PASSWORD_PROTECTED", msg: "Boutique protégée par mot de passe" });
  return { status, alerts };
}

function estimateDelay(country, interval) {
  if (interval === "MANUAL") return "manual";
  const map = { FR:3,DE:3,ES:3,IT:3,NL:3,BE:3,AT:3,IE:3,PT:3,FI:3,SE:3,DK:3,GB:3,US:2,CA:3,AU:3,NZ:3,JP:4,SG:4,HK:4,CH:3,NO:3,CZ:3,RO:3 };
  return map[country] || 3;
}

export function shapeStoreData(data, restShop) {
  const sp = data.shopifyPaymentsAccount;
  const shop = data.shop;
  const health = analyzeHealth(data, restShop);
  const payouts = (sp?.payouts?.edges || []).map((e) => ({
    id: e.node.legacyResourceId || e.node.id, date: e.node.issuedAt,
    amount: parseFloat(e.node.net?.amount || 0), currency: e.node.net?.currencyCode || shop?.currencyCode || "EUR",
    status: (e.node.status || "").toLowerCase(), type: e.node.transactionType,
    gross: parseFloat(e.node.summary?.chargesGross?.amount || 0), fee: parseFloat(e.node.summary?.chargesFee?.amount || 0),
    bank: e.node.bankAccount ? `${e.node.bankAccount.bankName} ····${e.node.bankAccount.accountNumberLastDigits}` : null,
  }));
  const banks = (sp?.bankAccounts?.edges || []).map((e) => ({
    id: e.node.id, name: e.node.bankName, last4: e.node.accountNumberLastDigits,
    currency: e.node.currency, country: e.node.country, status: e.node.status, createdAt: e.node.createdAt,
  }));
  const balance = (sp?.balance || []).map((b) => ({ amount: parseFloat(b.amount), currency: b.currencyCode }));
  const disputes = (sp?.disputes?.edges || []).map((e) => ({
    id: e.node.id, status: e.node.status, reason: e.node.reasonDetails?.reason,
    amount: parseFloat(e.node.amount?.amount || 0), currency: e.node.amount?.currencyCode,
    dueBy: e.node.evidenceDueBy, initiatedAt: e.node.initiatedAt,
  }));
  const country = sp?.country || shop?.billingAddress?.countryCodeV2 || "FR";
  const interval = sp?.payoutSchedule?.interval || null;
  return {
    name: shop?.name, domain: shop?.myshopifyDomain, primaryUrl: shop?.primaryDomain?.url,
    email: shop?.email, createdAt: shop?.createdAt, currency: shop?.currencyCode, country,
    plan: restShop?.plan_name || shop?.plan?.displayName, passwordEnabled: !!restShop?.password_enabled,
    lastOrderAt: data.orders?.edges?.[0]?.node?.createdAt || null,
    paymentsActivated: !!sp?.activated, payoutInterval: interval,
    payoutDelayDays: estimateDelay(country, interval),
    statementDescriptor: sp?.payoutStatementDescriptor,
    balance, banks, payouts, disputes, health, lastSync: new Date().toISOString(),
  };
}

export async function syncStore(store) {
  const [gql, rest] = await Promise.all([
    shopifyGraphQL(store.domain, store.token, FULL_QUERY),
    shopifyREST(store.domain, store.token, "shop.json").then((r) => r.shop).catch(() => null),
  ]);
  return shapeStoreData(gql, rest);
}

export function publicStore(s) {
  return {
    id: s.id, domain: s.domain, label: s.label, addedAt: s.added_at,
    tokenHint: s.token ? "••••" + s.token.slice(-4) : null,
    data: s.data, error: s.error,
  };
}
