// Browser origins allowed to call this API.
// cors reflects Access-Control-Allow-Origin only for this list. A request with no
// Origin header (Stripe webhooks, curl, other servers) is not rejected.
//
// http://localhost:3000 is included for local dev only. Vercel sets
// NODE_ENV=production, including on preview deployments, so a production API
// does not trust a browser on localhost. Add it to CORS_EXTRA_ORIGINS when a
// deployment really must be called from a local frontend.

const LOCAL_DEV_ORIGIN = "http://localhost:3000";

export function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

export function normalizeOrigin(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

function netlifyPreviewsEnabled(env) {
  const flag = String(env.CORS_ALLOW_NETLIFY_PREVIEWS ?? "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function netlifySiteName(env) {
  const origin = normalizeOrigin(env.FRONTEND_URL);
  if (!origin) return null;
  const match = /^([a-z0-9-]+)\.netlify\.app$/i.exec(new URL(origin).hostname);
  return match ? match[1].toLowerCase() : null;
}

// Opt-in deploy previews for this site only, e.g.
// https://deploy-preview-42--uprightmrp.netlify.app
// Not a *.netlify.app wildcard, and not branch-deploy hostnames.
export function netlifyDeployPreviewPattern(env = process.env) {
  if (!netlifyPreviewsEnabled(env)) return null;
  const site = netlifySiteName(env);
  if (!site) return null;
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https://deploy-preview-\\d+--${escaped}\\.netlify\\.app$`);
}

export function allowedOrigins(env = process.env) {
  const origins = new Set();
  const add = (value) => {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  };

  add(env.FRONTEND_URL);
  if (!isProductionEnv(env)) add(LOCAL_DEV_ORIGIN);
  for (const part of String(env.CORS_EXTRA_ORIGINS ?? "").split(",")) {
    add(part);
  }

  const list = [...origins];
  const preview = netlifyDeployPreviewPattern(env);
  if (preview) list.push(preview);
  return list;
}

export function createCorsOptions(env = process.env) {
  return {
    origin(_origin, callback) {
      const allowed = allowedOrigins(env);
      // An empty allowlist must not fall through to cors's default "*".
      callback(null, allowed.length > 0 ? allowed : false);
    },
  };
}

export const corsOptions = createCorsOptions();
