# Transactional email

`sendEmail({ to, template, data, clientId, userId })` in `lib/email/index.js` renders a template and sends it. It never throws, so signup, password reset, and the Stripe webhook keep working when mail is down.

Which provider runs:

1. Gmail, when both `GMAIL_USER` and `GMAIL_APP_PASSWORD` are set.
2. Resend, when Gmail is not configured and `RESEND_API_KEY` is set.
3. Otherwise the message is logged and skipped.

- `GMAIL_USER` — the Gmail address that sends. The From line is `Upright <GMAIL_USER>`.
- `GMAIL_APP_PASSWORD` — a Google app password, not the account password. Spaces are fine.
- `SUPPORT_EMAIL` — the Reply-To address. Defaults to `uprightmrp@gmail.com`.
- `RESEND_API_KEY` — used only when Gmail is not configured. When it is also missing, nothing is sent.
- `EMAIL_FROM` — the From address for Resend. Defaults to `Upright <onboarding@resend.dev>`. Gmail does not use this.
- `FRONTEND_URL` — links in the emails, with no trailing slash added.

## Gmail app password

Google only offers app passwords after 2-Step Verification is on for that account.

1. Open the Google account that will send the mail and turn on 2-Step Verification (Security → 2-Step Verification).
2. Open https://myaccount.google.com/apppasswords.
3. Create an app password named Upright. Google shows 16 letters in groups of four.
4. In Vercel, set `GMAIL_USER` to that account's address and `GMAIL_APP_PASSWORD` to the 16 letters. Set `SUPPORT_EMAIL` only if replies should go somewhere other than `uprightmrp@gmail.com`.

Every attempt is written to `email_log` with status `sent`, `failed`, or `skipped`, for Gmail and for Resend. A missing table or a provider error is recorded and does not fail the request that asked for the email.

## Adding a template

Templates are plain functions in `lib/email/templates.js`. Each one returns `{ subject, html, text }` and should use `renderEmail` so the layout stays the same.

1. Add a function next to the others. Keep the copy short and plain. Put links in `action`, not in the paragraphs.
2. Register it on the `templates` object. The key is the name you pass as `template`.
3. Call it from the feature:

```js
import { sendEmail } from "../lib/email/index.js";

await sendEmail({
  to: user.email,
  template: "low_stock",
  data: { name: user.name, itemName, quantity },
  clientId: user.client_id,
  userId: user.id,
});
```

Do not wrap the caller in extra failure handling unless you need the return value. `sendEmail` already catches provider and logging errors.

Low-stock reminders and batch due-date reminders are not sent yet. Add them the same way when those jobs exist: a `low_stock` function and a `batch_due` function, then a scheduled caller that uses `sendEmail`.
