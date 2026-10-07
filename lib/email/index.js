import { Resend } from "resend";
import { pool } from "../db.js";
import { renderTemplate } from "./templates.js";

export { renderTemplate, templates } from "./templates.js";

const DEFAULT_FROM = "Upright <onboarding@resend.dev>";

let cachedKey = "";
let cachedClient = null;
let testOverride = { active: false, client: null };

export function emailFromAddress() {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
}

/** Tests pass a fake `{ emails: { send } }`, or null to force the no-key path. */
export function setResendForTests(client) {
  testOverride = { active: true, client };
}

export function resetEmailForTests() {
  testOverride = { active: false, client: null };
  cachedClient = null;
  cachedKey = "";
}

function resendClient() {
  if (testOverride.active) return testOverride.client;
  const key = process.env.RESEND_API_KEY?.trim() ?? "";
  if (!key) return null;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedKey = key;
  cachedClient = new Resend(key);
  return cachedClient;
}

function optionalId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function errorText(err) {
  const message = err?.message ? String(err.message) : String(err ?? "Email failed");
  return message.slice(0, 500);
}

async function writeEmailLog(query, row) {
  try {
    await query(
      `INSERT INTO email_log
         (client_id, user_id, to_address, template, status, provider_message_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        optionalId(row.clientId),
        optionalId(row.userId),
        String(row.to ?? ""),
        String(row.template ?? ""),
        row.status,
        row.providerMessageId ?? null,
        row.error ?? null,
      ]
    );
  } catch (err) {
    console.error("email_log insert failed:", err?.message ?? err);
  }
}

/**
 * Send one transactional email and record it in email_log.
 * Never throws. Without RESEND_API_KEY the message is logged and skipped.
 *
 * @param {{ to: string, template: string, data?: object, clientId?: number, userId?: number }} input
 */
export async function sendEmail(input = {}) {
  const to = String(input.to ?? "").trim();
  const template = String(input.template ?? "").trim();
  const query = pool.query.bind(pool);

  if (!to || !template) {
    await writeEmailLog(query, {
      ...input,
      to,
      template,
      status: "failed",
      error: "Missing recipient or template",
    });
    return { status: "failed", error: "Missing recipient or template" };
  }

  let rendered;
  try {
    rendered = renderTemplate(template, input.data ?? {});
  } catch (err) {
    const error = errorText(err);
    await writeEmailLog(query, { ...input, to, template, status: "failed", error });
    return { status: "failed", error };
  }

  const client = resendClient();
  if (!client) {
    console.info(
      `Email skipped (RESEND_API_KEY is not set): ${template} → ${to}`
    );
    await writeEmailLog(query, { ...input, to, template, status: "skipped" });
    return { status: "skipped" };
  }

  try {
    const result = await client.emails.send({
      from: emailFromAddress(),
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (result?.error) {
      const error = errorText(result.error);
      await writeEmailLog(query, {
        ...input,
        to,
        template,
        status: "failed",
        error,
      });
      return { status: "failed", error };
    }
    const providerMessageId = result?.data?.id ?? result?.id ?? null;
    await writeEmailLog(query, {
      ...input,
      to,
      template,
      status: "sent",
      providerMessageId,
    });
    return { status: "sent", id: providerMessageId };
  } catch (err) {
    const error = errorText(err);
    console.error("Email send failed:", error);
    await writeEmailLog(query, { ...input, to, template, status: "failed", error });
    return { status: "failed", error };
  }
}
