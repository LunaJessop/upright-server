import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_email_test";
process.env.FRONTEND_URL = "https://app.example.com";
delete process.env.RESEND_API_KEY;
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;
delete process.env.SUPPORT_EMAIL;

const { pool } = await import("../lib/db.js");
const { EMAIL_FOOTER } = await import("../lib/email/layout.js");
const {
  emailFromAddress,
  gmailFromAddress,
  gmailTransportOptions,
  renderTemplate,
  resetEmailForTests,
  selectEmailProvider,
  sendEmail,
  setNodemailerForTests,
  setResendForTests,
  supportEmailAddress,
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
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
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
    assert.equal(sent[0].replyTo, "uprightmrp@gmail.com");
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

  describe("gmail smtp", () => {
  const gmailEnv = {
    GMAIL_USER: "uprightmrp@gmail.com",
    GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
  };

  function withEnv(vars, fn) {
    const previous = {};
    for (const [key, value] of Object.entries(vars)) {
      previous[key] = process.env[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    const restore = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    return Promise.resolve()
      .then(fn)
      .finally(restore);
  }

  it("prefers Gmail when both vars are set, even if Resend is also set", () => {
    assert.equal(selectEmailProvider(gmailEnv), "gmail");
    assert.equal(
      selectEmailProvider({ ...gmailEnv, RESEND_API_KEY: "re_test" }),
      "gmail"
    );
    assert.equal(
      selectEmailProvider({ GMAIL_USER: "uprightmrp@gmail.com", RESEND_API_KEY: "re_test" }),
      "resend"
    );
    assert.equal(
      selectEmailProvider({ GMAIL_APP_PASSWORD: "abcdefghijklmnop", RESEND_API_KEY: "re_test" }),
      "resend"
    );
    assert.equal(selectEmailProvider({ RESEND_API_KEY: "re_test" }), "resend");
    assert.equal(selectEmailProvider({}), "skip");
    assert.equal(
      selectEmailProvider({ GMAIL_USER: "uprightmrp@gmail.com", GMAIL_APP_PASSWORD: "   " }),
      "skip"
    );
  });

  it("uses smtp.gmail.com port 465 and drops spaces in the app password", () => {
    assert.deepEqual(gmailTransportOptions(gmailEnv), {
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: "uprightmrp@gmail.com",
        pass: "abcdefghijklmnop",
      },
    });
    assert.equal(gmailFromAddress(gmailEnv), "Upright <uprightmrp@gmail.com>");
    assert.equal(supportEmailAddress({}), "uprightmrp@gmail.com");
    assert.equal(
      supportEmailAddress({ SUPPORT_EMAIL: " help@example.com " }),
      "help@example.com"
    );
  });

  it("sends through a mocked Gmail transport and logs the message id", async () => {
    resetEmailForTests();
    const queries = installLog();
    const sent = [];
    const created = [];
    setNodemailerForTests((options) => {
      created.push(options);
      return {
        async sendMail(payload) {
          sent.push(payload);
          return { messageId: "<abc@smtp.gmail.com>" };
        },
      };
    });

    await withEnv({ ...gmailEnv, RESEND_API_KEY: "re_should_not_be_used", SUPPORT_EMAIL: "" }, async () => {
      delete process.env.SUPPORT_EMAIL;
      const result = await sendEmail({
        to: "ada@example.com",
        template: "welcome",
        data: { name: "Ada", companyName: "Soap Co" },
        clientId: 4,
        userId: 8,
      });
      assert.deepEqual(result, { status: "sent", id: "<abc@smtp.gmail.com>" });
    });

    assert.equal(created.length, 1);
    assert.equal(created[0].host, "smtp.gmail.com");
    assert.equal(created[0].port, 465);
    assert.equal(created[0].secure, true);
    assert.deepEqual(created[0].auth, {
      user: "uprightmrp@gmail.com",
      pass: "abcdefghijklmnop",
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, "Upright <uprightmrp@gmail.com>");
    assert.equal(sent[0].replyTo, "uprightmrp@gmail.com");
    assert.equal(sent[0].to, "ada@example.com");
    assert.match(sent[0].subject, /Welcome/);
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[4], "sent");
    assert.equal(log.params[5], "<abc@smtp.gmail.com>");
    assert.equal(log.params[6], null);
  });

  it("uses SUPPORT_EMAIL as reply-to and does not throw when Gmail fails", async () => {
    resetEmailForTests();
    const queries = installLog();
    const sent = [];
    setNodemailerForTests(() => ({
      async sendMail(payload) {
        sent.push(payload);
        throw new Error("invalid login");
      },
    }));
    const original = console.error;
    console.error = () => {};
    try {
      await withEnv(
        { ...gmailEnv, SUPPORT_EMAIL: "help@example.com" },
        async () => {
          const result = await sendEmail({
            to: "ada@example.com",
            template: "password_reset",
            data: {
              name: "Ada",
              resetUrl: "https://app.example.com/reset-password?token=abc",
            },
            clientId: 4,
            userId: 8,
          });
          assert.equal(result.status, "failed");
          assert.match(result.error, /invalid login/);
        }
      );
    } finally {
      console.error = original;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyTo, "help@example.com");
    assert.equal(sent[0].from, "Upright <uprightmrp@gmail.com>");
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[4], "failed");
    assert.match(log.params[6], /invalid login/);
  });

  it("does not open SMTP when only one Gmail variable is set", async () => {
    resetEmailForTests();
    const queries = installLog();
    let created = 0;
    setNodemailerForTests(() => {
      created += 1;
      throw new Error("should not create a transport");
    });
    const lines = [];
    const original = console.info;
    console.info = (line) => lines.push(String(line));
    try {
      await withEnv(
        { GMAIL_USER: "uprightmrp@gmail.com", GMAIL_APP_PASSWORD: null, RESEND_API_KEY: null },
        async () => {
          const result = await sendEmail({
            to: "ada@example.com",
            template: "welcome",
            data: { name: "Ada", companyName: "Soap Co" },
          });
          assert.deepEqual(result, { status: "skipped" });
        }
      );
    } finally {
      console.info = original;
    }
    assert.equal(created, 0);
    assert.match(lines.join("\n"), /RESEND_API_KEY is not set/);
    const log = queries.find((query) => query.sql.includes("INSERT INTO email_log"));
    assert.equal(log.params[4], "skipped");
  });
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
    assert.match(sql, /reset_password/);
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
