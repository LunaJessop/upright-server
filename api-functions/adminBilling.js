import {
  billingFieldsFromClient,
  getClientBilling,
  getStripe,
} from "../lib/billing.js";

const INVOICE_LIMIT = 10;

function planFromPriceId(priceId) {
  if (!priceId) return null;
  const monthly =
    process.env.STRIPE_PRICE_ID_MONTHLY?.trim() ||
    process.env.STRIPE_PRICE_ID?.trim() ||
    "";
  const yearly = process.env.STRIPE_PRICE_ID_YEARLY?.trim() || "";
  if (monthly && priceId === monthly) return "monthly";
  if (yearly && priceId === yearly) return "yearly";
  return null;
}

function storedBilling(row) {
  const billing = billingFieldsFromClient(row);
  return {
    id: row.id,
    subscription_status: billing.subscription_status,
    plan: planFromPriceId(row.stripe_price_id),
    plan_price_id: billing.plan_price_id,
    current_period_end: row.current_period_end ?? null,
    past_due_started_at: row.past_due_started_at ?? null,
    grace_days_remaining: billing.grace_days_remaining,
    read_only: billing.read_only,
    has_app_access: billing.has_app_access,
    stripe_customer_id: row.stripe_customer_id ?? null,
    stripe_subscription_id: row.stripe_subscription_id ?? null,
  };
}

function emptyStripe(extra = {}) {
  return {
    configured: false,
    invoices: [],
    payment_method: null,
    upcoming_invoice: null,
    error: null,
    ...extra,
  };
}

function unixDate(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function invoiceSummary(invoice, { includeUrl = true } = {}) {
  if (!invoice) return null;
  const stamp =
    invoice.next_payment_attempt || invoice.due_date || invoice.created || null;
  const summary = {
    id: invoice.id ?? null,
    date: unixDate(stamp),
    amount: invoice.total ?? invoice.amount_due ?? null,
    currency: invoice.currency ?? null,
    status: invoice.status ?? null,
  };
  if (includeUrl) {
    summary.hosted_invoice_url = invoice.hosted_invoice_url ?? null;
  }
  return summary;
}

function cardSummary(paymentMethod) {
  const card = paymentMethod?.card;
  if (!card?.last4) return null;
  return {
    brand: card.brand ?? null,
    last4: card.last4,
  };
}

async function paymentMethodForCustomer(stripe, customerId) {
  const customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  const fromDefault = cardSummary(customer?.invoice_settings?.default_payment_method);
  if (fromDefault) return fromDefault;

  const listed = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1,
  });
  return cardSummary(listed?.data?.[0]);
}

async function liveStripe(row) {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    return emptyStripe();
  }
  if (!row.stripe_customer_id) {
    return emptyStripe({ configured: true });
  }

  const stripe = getStripe();
  const [invoicesResult, paymentResult, upcomingResult] = await Promise.allSettled([
    stripe.invoices.list({
      customer: row.stripe_customer_id,
      limit: INVOICE_LIMIT,
    }),
    paymentMethodForCustomer(stripe, row.stripe_customer_id),
    row.stripe_subscription_id
      ? stripe.invoices.createPreview({
          customer: row.stripe_customer_id,
          subscription: row.stripe_subscription_id,
        })
      : Promise.resolve(null),
  ]);

  const failed = [];
  let invoices = [];
  if (invoicesResult.status === "fulfilled") {
    invoices = (invoicesResult.value?.data ?? [])
      .slice(0, INVOICE_LIMIT)
      .map((invoice) => invoiceSummary(invoice));
  } else {
    console.error(invoicesResult.reason);
    failed.push("invoices");
  }

  let paymentMethod = null;
  if (paymentResult.status === "fulfilled") {
    paymentMethod = paymentResult.value ?? null;
  } else {
    console.error(paymentResult.reason);
    failed.push("payment_method");
  }

  let upcoming = null;
  if (upcomingResult.status === "fulfilled") {
    upcoming = upcomingResult.value
      ? invoiceSummary(upcomingResult.value, { includeUrl: false })
      : null;
  } else {
    console.error(upcomingResult.reason);
    failed.push("upcoming_invoice");
  }

  return {
    configured: true,
    invoices,
    payment_method: paymentMethod,
    upcoming_invoice: upcoming,
    error: failed.length > 0 ? `Stripe request failed: ${failed.join(", ")}` : null,
  };
}

export async function getAdminCustomerBilling(req, res) {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ error: "Invalid customer id" });
  }

  try {
    const row = await getClientBilling(customerId);
    if (!row) return res.status(404).json({ error: "Customer not found" });

    const stripe = await liveStripe(row);
    res.json({
      billing: storedBilling(row),
      stripe,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load billing" });
  }
}
