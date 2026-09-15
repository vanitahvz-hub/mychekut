import { checkAuth, getAppCredentials, getInstallUrl } from "../_lib.js";

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const domain = req.query.domain;
  if (!domain) return res.status(400).json({ error: "domain requis" });

  const clean = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const { clientId } = getAppCredentials();
  if (!clientId) return res.status(500).json({ error: "SHOPIFY_CLIENT_ID manquant dans Vercel" });

  const host = req.headers.host || "mychekut.vercel.app";
  const redirectUri = `https://${host}/api/auth/callback`;
  const url = getInstallUrl(clean, clientId, redirectUri);

  res.json({ url, domain: clean });
}
