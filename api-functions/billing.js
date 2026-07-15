import {
  createCheckoutSessionForClient,
  createPortalSessionForClient,
  getClientBilling,
  PLAN_KEYS,
} from "../lib/billing.js";

export async function createCheckout(req, res) {
  try {
    const plan = String(req.body?.plan ?? "monthly").toLowerCase();
    if (!PLAN_KEYS.includes(plan)) {
      return res.status(400).json({
        error: `Invalid plan. Use one of: ${PLAN_KEYS.join(", ")}`,
      });
    }

    const client = await getClientBilling(req.auth.clientId);
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    if (client.subscription_status === "active") {
      return res.status(400).json({ error: "Subscription is already active" });
    }

    const session = await createCheckoutSessionForClient(client, plan);
    if (!session.url) {
      return res.status(500).json({ error: "Failed to create checkout session" });
    }

    res.json({ checkoutUrl: session.url, plan });
  } catch (err) {
    console.error(err);
    if (err.message?.includes("STRIPE_")) {
      return res.status(503).json({ error: err.message });
    }
    if (err?.statusCode === 401 || err?.type === "StripeAuthenticationError") {
      return res.status(503).json({
        error: "Stripe authentication failed. Check STRIPE_SECRET_KEY in server .env",
      });
    }
    res.status(500).json({ error: "Failed to start checkout" });
  }
}

export async function createPortal(req, res) {
  try {
    const client = await getClientBilling(req.auth.clientId);
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    const session = await createPortalSessionForClient(client);
    res.json({ portalUrl: session.url });
  } catch (err) {
    console.error(err);
    if (err.message === "No Stripe customer on this account") {
      return res.status(400).json({ error: err.message });
    }
    if (err.message?.includes("STRIPE_")) {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to open billing portal" });
  }
}
