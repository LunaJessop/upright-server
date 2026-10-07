import { getFrontendUrl } from "../billing.js";
import { renderEmail } from "./layout.js";

function greetingName(name) {
  const trimmed = String(name ?? "").trim();
  return trimmed || "there";
}

function companyLabel(companyName) {
  const trimmed = String(companyName ?? "").trim();
  return trimmed || "your company";
}

export function welcome({ name, companyName } = {}) {
  const appUrl = getFrontendUrl();
  const company = companyLabel(companyName);
  const { html, text } = renderEmail({
    heading: "Welcome to Upright",
    paragraphs: [
      `Hi ${greetingName(name)},`,
      `${company} is set up. You can keep recipes, stock, and batches in one place.`,
    ],
    action: { href: appUrl, label: "Open Upright" },
  });
  return { subject: "Welcome to Upright", html, text };
}

export function passwordReset({ name, resetUrl } = {}) {
  const { html, text } = renderEmail({
    heading: "Reset your password",
    paragraphs: [
      `Hi ${greetingName(name)},`,
      "We got a request to reset your Upright password. This link works for one hour and can only be used once.",
      "If you didn't ask for this, you can ignore this email. Your password will stay the same.",
    ],
    action: { href: String(resetUrl ?? ""), label: "Reset password" },
  });
  return { subject: "Reset your Upright password", html, text };
}

export function paymentSucceeded({ name, companyName, amount, invoiceNumber, receiptUrl } = {}) {
  const company = companyLabel(companyName);
  const paid = amount ? `${amount}` : "your payment";
  const invoiceLine = invoiceNumber
    ? `This was invoice ${invoiceNumber}.`
    : "This receipt is for your Upright subscription.";
  const { html, text } = renderEmail({
    heading: "We received your payment",
    paragraphs: [
      `Hi ${greetingName(name)},`,
      `Thank you. We received ${paid} for ${company}.`,
      invoiceLine,
    ],
    action: receiptUrl
      ? { href: String(receiptUrl), label: "View receipt" }
      : undefined,
  });
  return { subject: "We received your Upright payment", html, text };
}

export function paymentFailed({ name, companyName, amount } = {}) {
  const company = companyLabel(companyName);
  const charge = amount ? ` of ${amount}` : "";
  const { html, text } = renderEmail({
    heading: "Your payment didn't go through",
    paragraphs: [
      `Hi ${greetingName(name)},`,
      `We couldn't collect the latest payment${charge} for ${company}.`,
      "Update your payment method in Upright so your subscription stays active.",
    ],
    action: { href: getFrontendUrl(), label: "Open Upright" },
  });
  return { subject: "Your Upright payment didn't go through", html, text };
}

export function subscriptionCanceled({ name, companyName } = {}) {
  const company = companyLabel(companyName);
  const { html, text } = renderEmail({
    heading: "Your subscription is canceled",
    paragraphs: [
      `Hi ${greetingName(name)},`,
      `The Upright subscription for ${company} is canceled. You won't be charged again.`,
      "If this was a mistake, you can subscribe again after you sign in.",
    ],
    action: { href: getFrontendUrl(), label: "Open Upright" },
  });
  return { subject: "Your Upright subscription is canceled", html, text };
}

/**
 * Template name → function. sendEmail looks up the name here.
 * To add one: write a function that returns { subject, html, text },
 * then add it to this object. See lib/email/README.md.
 */
export const templates = {
  welcome,
  password_reset: passwordReset,
  payment_succeeded: paymentSucceeded,
  payment_failed: paymentFailed,
  subscription_canceled: subscriptionCanceled,
};

export function renderTemplate(name, data = {}) {
  const build = templates[name];
  if (!build) {
    throw new Error(`Unknown email template "${name}"`);
  }
  const rendered = build(data);
  if (
    !rendered?.subject ||
    !rendered?.html ||
    !rendered?.text
  ) {
    throw new Error(`Email template "${name}" did not return subject, html, and text`);
  }
  return rendered;
}
