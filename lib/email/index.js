import nodemailer from "nodemailer";
import { Resend } from "resend";
import { pool } from "../db.js";
import { renderTemplate } from "./templates.js";

export { renderTemplate, templates } from "./templates.js";

const DEFAULT_FROM = "Upright <onboarding@resend.dev>";
const DEFAULT_SUPPORT_EMAIL = "uprightmrp@gmail.com";

let cachedKey = "";
let cachedClient = null;
let cachedTransport = null;
let cachedTransportKey = "";
let createTransport = (options) => nodemailer.createTransport(options);

// Tests pick a provider directly so a developer machine with Gmail env vars
// cannot send during the suite. null means "use the environment".
let testMode = null;

export function emailFromAddress() {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
}

export function supportEmailAddress(env = process.env) {
  return String(env.SUPPORT_EMAIL ?? "").trim() || DEFAULT_SUPPORT_EMAIL;
}

/** Gmail address plus app password, or null when either one is missing. */
export function gmailAuth(env = process.env) {
  const user = String(env.GMAIL_USER ?? "").trim();
  // Google shows the app password in groups of four. Spaces still work.
  const pass = String(env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

export function gmailFromAddress(env = process.env) {
  const auth = gmailAuth(env);
  if (!auth) return null;
  return `Upright <${auth.user}>`;
}

export function gmailTransportOptions(env = process.env) {
  const auth = gmailAuth(env);
  if (!auth) return null;
  return {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth,
  };
}

/** "gmail" when both Gmail vars are set, else "resend" when that key is set, else "skip". */
export function selectEmailProvider(env = process.env) {
  if (gmailAuth(env)) return "gmail";
  if (String(env.RESEND_API_KEY ?? "").trim()) return "resend";
  return "skip";
}

/** Tests pass a fake `{ emails: { send } }`, or null to force the no-provider path. */
export function setResendForTests(client) {
  testMode = { kind: "resend", client };
}

/** Tests pass a fake `{ sendMail }` so nothing opens a real SMTP connection. */
export function setMailTransportForTests(transport) {
  testMode = { kind: "gmail", transport };
}

/** Tests replace nodemailer so createTransport is recorded and sendMail is fake. */
export function setNodemailerForTests(factory) {
  createTransport = factory;
  cachedTransport = null;
  cachedTransportKey = "";
}

export function resetEmailForTests() {
  testMode = null;
  cachedClient = null;
  cachedKey = "";
  cachedTransport = null;
  cachedTransportKey = "";
  createTransport = (options) => nodemailer.createTransport(options);
}

function resendClient() {
  const key = process.env.RESEND_API_KEY?.trim() ?? "";
  if (!key) return null;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedKey = key;
  cachedClient = new Resend(key);
  return cachedClient;
}

function gmailTransport() {
  const options = gmailTransportOptions();
  if (!options) return null;
  const key = `${options.auth.user}\0${options.auth.pass}`;
  if (cachedTransport && cachedTransportKey === key) return cachedTransport;
  cachedTransportKey = key;
  cachedTransport = createTransport(options);
  return cachedTransport;
}

function chooseProvider() {
  if (testMode?.kind === "gmail") {
    return { kind: "gmail", transport: testMode.transport };
  }
  if (testMode?.kind === "resend") {
    return testMode.client ? { kind: "resend", client: testMode.client } : null;
  }
  if (selectEmailProvider() === "gmail") {
    const transport = gmailTransport();
    if (transport) return { kind: "gmail", transport };
  }
  const client = resendClient();
  if (client) return { kind: "resend", client };
  return null;
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
 * Never throws. Gmail is used when GMAIL_USER and GMAIL_APP_PASSWORD are
 * both set. Otherwise Resend is used when RESEND_API_KEY is set. With
 * neither, the message is logged and skipped.
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

  const provider = chooseProvider();
  if (!provider) {
    console.info(
      `Email skipped (Gmail is not configured and RESEND_API_KEY is not set): ${template} → ${to}`
    );
    await writeEmailLog(query, { ...input, to, template, status: "skipped" });
    return { status: "skipped" };
  }

  try {
    if (provider.kind === "gmail") {
      const info = await provider.transport.sendMail({
        from: gmailFromAddress(),
        to,
        replyTo: supportEmailAddress(),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      const providerMessageId = info?.messageId ?? null;
      await writeEmailLog(query, {
        ...input,
        to,
        template,
        status: "sent",
        providerMessageId,
      });
      return { status: "sent", id: providerMessageId };
    }

    const result = await provider.client.emails.send({
      from: emailFromAddress(),
      to,
      replyTo: supportEmailAddress(),
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
