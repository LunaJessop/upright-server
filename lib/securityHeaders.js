import { isProductionEnv } from "./cors.js";

// Helmet's default Cross-Origin-Resource-Policy is same-origin. The app at
// https://uprightmrp.netlify.app is a different site from this API, and that
// default would make the browser throw away otherwise valid responses.
// cross-origin keeps those reads working. CORS still decides which sites
// are allowed to read them.
const CROSS_ORIGIN_RESOURCE_POLICY = Object.freeze({
  policy: "cross-origin",
});

// 180 days. Matches helmet's own default, and only sent in production so a
// laptop browser does not pin http://localhost to HTTPS (the Next.js app
// and this API use different localhost ports).
const PRODUCTION_HSTS = Object.freeze({
  maxAge: 15552000,
  includeSubDomains: true,
});

export function createSecurityHeaders(env = process.env) {
  return {
    crossOriginResourcePolicy: CROSS_ORIGIN_RESOURCE_POLICY,
    hsts: isProductionEnv(env) ? PRODUCTION_HSTS : false,
  };
}

export const securityHeaders = createSecurityHeaders();
