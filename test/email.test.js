import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_email_test";
process.env.FRONTEND_URL = "https://app.example.com";
delete process.env.RESEND_API_KEY;

const { pool } = await import("../lib/db.js");
const { EMAIL_FOOTER } = await import("../lib/email/layout.js");
const {
  emailFromAddress,
  renderTemplate,
  resetEmailForTests,
  sendEmail,
  setResendForTests,
  templates,
} = await import("../lib/email/index.js");

pool.options.connectionTimeoutMillis = 500;

function installLog() {
  const queries = [];
  pool.query = async (sql, params = []) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).includes("INSERT INTO email_log")) {
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  };
  return queries;
}

after(async () => {
  resetEmailForTests();
  await pool.end();
});

describe("email templates", () => {
  const names = [
    "welcome",
    "password_reset",
    "payment_succeeded",
    "payment_failed",
    "subscription_canceled",
  ];

  it("renders every template with a shared layout and plain text", () => {
    const samples = {
      welcome: { name: "Ada", companyName: "Soap Co" },
      password_reset: {
        name: "Ada",
        resetUrl: "https://app.example.com/reset-password?token=abc",
      },
      payment_succeeded: {
        name: "Ada",
        companyName: "Soap Co",
        amount: "$25.00",
        invoiceNumber: "INV-1",
        receiptUrl: "https://pay.stripe.test/receipt",
      },
      payment_failed: { name: "Ada", companyName: "Soap Co", amount: "$25.00" },
      subscription_canceled: { name: "Ada", companyName: "Soap Co" },
    };

    for (const name of names) {
      const rendered = renderTemplate(name, samples[name]);
      assert.equal(typeof rendered.subject, "string");
      assert.ok(rendered.subject.length > 0);
      assert.match(rendered.html, /Upright/);
      assert.match(rendered.html, new RegExp(EMAIL_FOOTER));
      assert.match(rendered.text, new RegExp(EMAIL_FOOTER));
      assert.match(rendered.text, /Ada/);
    }
  });

  it("escapes names in html and keeps the reset link in both parts", () => {
    const rendered = renderTemplate("password_reset", {
      name: "<b>Ada</b>",
      resetUrl: "https://app.example.com/reset-password?token=abc",
    });
    assert.match(rendered.html, /&lt;b&gt;Ada&lt;\/b&gt;/);
    assert.doesNotMatch(rendered.html, /<b>Ada<\/b>/);
    assert.match(rendered.html, /https:\/\/app\.example\.com\/reset-password\?token=abc/);
    assert.match(rendered.text, /https:\/\/app\.example\.com\/reset-password\?token=abc/);
    assert.match(rendered.text, /<b>Ada<\/b>/);
  });

  it("points welcome links at FRONTEND_URL", () => {
    const rendered = renderTemplate("welcome", { name: "Ada", companyName: "Soap Co" });
    assert.match(rendered.html, /https:\/\/app\.example\.com/);
    assert.doesNotMatch(rendered.html, /https:\/\/app\.example\.com\//);
  });

  it("documents how to add a template", () => {
    const readme = readFileSync(new URL("../lib/email/README.md", import.meta.url), "utf8");
    assert.match(readme, /Adding a template/);
    assert.match(readme, /templates/);
    assert.match(readme, /low_stock/);
    assert.match(readme, /batch_due/);
    assert.ok(templates.welcome);
    assert.equal(Object.keys(templates).length, names.length);
  });
});

describe("sendEmail", { concurrency: 1 }, () => {
  it("logs and skips when RESEND_API_KEY is missing", async () => {
    resetEmailForTests();
    delete process.env.RESEND_API_KEY;
    const queries = installLog();
    const lines = [];
    const original = console.info;
    console.info = (line) => lines.push(String(line));
    try {
      const result = await sendEmail({
        to: "ada@example.com",
        template: "welcome",
        data: { name: "Ada", companyName: "Soap Co" },
        clientId: 4,
        userId: 8,
      });
      assert.deepEqual(result, { status: "skipped" });
    } finally {
      console.info = original;
    }

    assert.match(lines.join("\n"), /RESEND_API_KEY is not set/);
    assert.match(lines.join("\n"), /welcome/);
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.deepEqual(log.params, [
      4,
      8,
      "ada@example.com",
      "welcome",
      "skipped",
      null,
      null,
    ]);
  });

  it("sends through Resend and stores the provider id", async () => {
    const queries = installLog();
    const sent = [];
    setResendForTests({
      emails: {
        async send(payload) {
          sent.push(payload);
          return { data: { id: "msg_1" }, error: null };
        },
      },
    });

    const result = await sendEmail({
      to: "ada@example.com",
      template: "payment_succeeded",
      data: { name: "Ada", companyName: "Soap Co", amount: "$25.00" },
      clientId: 4,
      userId: 8,
    });

    assert.deepEqual(result, { status: "sent", id: "msg_1" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, emailFromAddress());
    assert.equal(sent[0].to, "ada@example.com");
    assert.equal(sent[0].subject, "We received your Upright payment");
    assert.match(sent[0].html, /\$25\.00/);
    assert.match(sent[0].text, /\$25\.00/);
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[4], "sent");
    assert.equal(log.params[5], "msg_1");
  });

  it("records a provider error and does not throw", async () => {
    const queries = installLog();
    setResendForTests({
      emails: {
        async send() {
          return { data: null, error: { message: "domain is not verified" } };
        },
      },
    });

    const result = await sendEmail({
      to: "ada@example.com",
      template: "welcome",
      data: { name: "Ada" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /domain is not verified/);
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[4], "failed");
    assert.match(log.params[6], /domain is not verified/);
  });

  it("records a thrown provider error and still returns", async () => {
    const queries = installLog();
    setResendForTests({
      emails: {
        async send() {
          throw new Error("network down");
        },
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const result = await sendEmail({
        to: "ada@example.com",
        template: "welcome",
        data: { name: "Ada" },
      });
      assert.equal(result.status, "failed");
      assert.match(result.error, /network down/);
    } finally {
      console.error = original;
    }
    assert.equal(
      queries.filter((query) => query.sql.includes("INSERT INTO email_log")).length,
      1
    );
  });

  it("does not throw when email_log cannot be written", async () => {
    pool.query = async () => {
      throw new Error("relation email_log does not exist");
    };
    setResendForTests({
      emails: {
        async send() {
          return { data: { id: "msg_2" }, error: null };
        },
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const result = await sendEmail({
        to: "ada@example.com",
        template: "welcome",
        data: { name: "Ada" },
      });
      assert.deepEqual(result, { status: "sent", id: "msg_2" });
    } finally {
      console.error = original;
    }
  });

  it("uses the default From address until EMAIL_FROM is set", () => {
    const previous = process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM;
    try {
      assert.equal(emailFromAddress(), "Upright <onboarding@resend.dev>");
    } finally {
      if (previous === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = previous;
    }
  });
});

describe("email sql", () => {
  it("ends with the check query", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/email-and-password-reset.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /CREATE TABLE IF NOT EXISTS email_log/);
    assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('sent', 'failed', 'skipped'\)\)/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS password_reset_tokens/);
    assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
    assert.match(sql, /forgot_password/);
    const statements = sql
      .split(/;\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith("--"));
    const last = statements[statements.length - 1];
    assert.match(last, /^SELECT/);
    assert.match(last, /to_regclass\('public\.email_log'\)/);
    assert.match(last, /to_regclass\('public\.password_reset_tokens'\)/);
    assert.match(last, /forgot_password_rate_limit/);
  });
});
