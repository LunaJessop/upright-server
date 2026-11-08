import { pool } from "../lib/db.js";
import { billingFieldsFromClient, getFrontendUrl } from "../lib/billing.js";
import { sendEmail } from "../lib/email/index.js";
import { createResetToken, hashResetToken } from "./passwordReset.js";

const MAX_GRACE_EXTENSION_DAYS = 90;

export function confirmationError(body) {
  if (body?.confirm === true) return null;
  return {
    status: 400,
    body: {
      error: "Confirm this action with confirm: true",
      code: "CONFIRMATION_REQUIRED",
    },
  };
}

function ids(customerIdRaw, userIdRaw) {
  const customerId = Number(customerIdRaw);
  const userId = userIdRaw == null ? null : Number(userIdRaw);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return { error: { status: 400, body: { error: "Invalid customer id" } } };
  }
  if (userIdRaw != null && (!Number.isInteger(userId) || userId <= 0)) {
    return { error: { status: 400, body: { error: "Invalid user id" } } };
  }
  return { customerId, userId };
}

function userRecord(row) {
  return {
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active ?? true,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function loadMember(customerId, userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.client_id, u.name, u.email, u.role, u.active, u.created_at, u.updated_at,
            c.name AS client_name
     FROM users u
     JOIN clients c ON c.id = u.client_id
     WHERE u.id = $1 AND u.client_id = $2`,
    [userId, customerId]
  );
  return rows[0] ?? null;
}

function setAudit(res, audit) {
  res.locals = res.locals ?? {};
  res.locals.adminAudit = audit;
}

async function issueResetForUser(user) {
  const token = createResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      `UPDATE password_reset_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );
    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );
    await db.query("COMMIT");
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    throw err;
  } finally {
    db.release();
  }
  return `${getFrontendUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendMemberPasswordReset(req, res) {
  const blocked = confirmationError(req.body);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const parsed = ids(req.params.id, req.params.userId);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);

  try {
    const user = await loadMember(parsed.customerId, parsed.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const resetUrl = await issueResetForUser(user);
    const email = await sendEmail({
      to: user.email,
      template: "password_reset",
      data: { name: user.name, resetUrl },
      clientId: user.client_id,
      userId: user.id,
    });
    setAudit(res, {
      action: "send_password_reset",
      clientId: user.client_id,
      userId: user.id,
      recordType: "user",
      recordId: String(user.id),
      message: "Sent password reset email",
      before: null,
      after: { email: user.email, email_status: email.status },
    });
    res.json({ user: userRecord(user), email: { status: email.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send password reset" });
  }
}

export async function resendMemberInvite(req, res) {
  const blocked = confirmationError(req.body);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const parsed = ids(req.params.id, req.params.userId);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);

  try {
    const user = await loadMember(parsed.customerId, parsed.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const email = await sendEmail({
      to: user.email,
      template: "welcome",
      data: { name: user.name, companyName: user.client_name },
      clientId: user.client_id,
      userId: user.id,
    });
    setAudit(res, {
      action: "resend_invite",
      clientId: user.client_id,
      userId: user.id,
      recordType: "user",
      recordId: String(user.id),
      message: "Resent invite email",
      before: null,
      after: { email: user.email, email_status: email.status },
    });
    res.json({ user: userRecord(user), email: { status: email.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to resend invite" });
  }
}

export async function setMemberActive(req, res) {
  const blocked = confirmationError(req.body);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const parsed = ids(req.params.id, req.params.userId);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);
  if (typeof req.body?.active !== "boolean") {
    return res.status(400).json({ error: "active must be true or false" });
  }
  const active = req.body.active;

  try {
    const existing = await loadMember(parsed.customerId, parsed.userId);
    if (!existing) return res.status(404).json({ error: "User not found" });

    const { rows } = await pool.query(
      `UPDATE users
       SET active = $3,
           token_version = CASE WHEN $3 = FALSE THEN token_version + 1 ELSE token_version END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND client_id = $2
       RETURNING id, client_id, name, email, role, active, created_at, updated_at`,
      [parsed.userId, parsed.customerId, active]
    );
    const user = rows[0];
    setAudit(res, {
      action: active ? "activate_user" : "deactivate_user",
      clientId: parsed.customerId,
      userId: user.id,
      recordType: "user",
      recordId: String(user.id),
      message: active ? "Activated user" : "Deactivated user",
      before: { active: existing.active ?? true },
      after: { active: user.active },
    });
    res.json({ user: userRecord(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update user" });
  }
}

function customerRecord(row) {
  const billing = billingFieldsFromClient(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug ?? null,
    email: row.email ?? null,
    active: row.active ?? true,
    subscription_status: billing.subscription_status,
    past_due_started_at: row.past_due_started_at ?? null,
    grace_days_remaining: billing.grace_days_remaining,
    has_app_access: billing.has_app_access,
    read_only: billing.read_only,
    plan_price_id: billing.plan_price_id,
  };
}

async function loadCustomer(customerId) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, email, active, subscription_status, past_due_started_at,
            stripe_price_id, current_period_end
     FROM clients
     WHERE id = $1`,
    [customerId]
  );
  return rows[0] ?? null;
}

export async function setCustomerActive(req, res) {
  const blocked = confirmationError(req.body);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const parsed = ids(req.params.id);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);
  if (typeof req.body?.active !== "boolean") {
    return res.status(400).json({ error: "active must be true or false" });
  }

  try {
    const existing = await loadCustomer(parsed.customerId);
    if (!existing) return res.status(404).json({ error: "Customer not found" });

    const { rows } = await pool.query(
      `UPDATE clients
       SET active = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, name, slug, email, active, subscription_status, past_due_started_at,
                 stripe_price_id, current_period_end`,
      [parsed.customerId, req.body.active]
    );
    const customer = rows[0];
    setAudit(res, {
      action: customer.active ? "activate_customer" : "deactivate_customer",
      clientId: customer.id,
      recordType: "customer",
      recordId: String(customer.id),
      message: customer.active ? "Activated company" : "Deactivated company",
      before: { active: existing.active ?? true },
      after: { active: customer.active },
    });
    res.json({ customer: customerRecord(customer) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update customer" });
  }
}

export async function extendCustomerGrace(req, res) {
  const blocked = confirmationError(req.body);
  if (blocked) return res.status(blocked.status).json(blocked.body);
  const parsed = ids(req.params.id);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRACE_EXTENSION_DAYS) {
    return res.status(400).json({
      error: `days must be a whole number from 1 to ${MAX_GRACE_EXTENSION_DAYS}`,
    });
  }

  try {
    const existing = await loadCustomer(parsed.customerId);
    if (!existing) return res.status(404).json({ error: "Customer not found" });
    if (existing.subscription_status !== "past_due") {
      return res.status(400).json({
        error: "Grace can only be extended while the subscription is past due",
        code: "GRACE_NOT_APPLICABLE",
      });
    }

    const { rows } = await pool.query(
      `UPDATE clients
       SET past_due_started_at = COALESCE(past_due_started_at, CURRENT_TIMESTAMP)
             + ($2::int * INTERVAL '1 day'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND subscription_status = 'past_due'
       RETURNING id, name, slug, email, active, subscription_status, past_due_started_at,
                 stripe_price_id, current_period_end`,
      [parsed.customerId, days]
    );
    const customer = rows[0];
    if (!customer) {
      return res.status(409).json({ error: "Subscription status changed. Try again." });
    }
    setAudit(res, {
      action: "extend_grace",
      clientId: customer.id,
      recordType: "customer",
      recordId: String(customer.id),
      message: `Extended billing grace by ${days} days`,
      before: { past_due_started_at: existing.past_due_started_at ?? null },
      after: { past_due_started_at: customer.past_due_started_at, days },
    });
    res.json({ customer: customerRecord(customer) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to extend grace" });
  }
}
