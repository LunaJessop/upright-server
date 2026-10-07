# Transactional email

`sendEmail({ to, template, data, clientId, userId })` in `lib/email/index.js` renders a template and sends it with Resend.

- `RESEND_API_KEY` — required in production. When it is missing (local dev and tests), the message is logged and not sent. `sendEmail` does not throw.
- `EMAIL_FROM` — the From address. Until a domain is verified, this defaults to `Upright <onboarding@resend.dev>`.
- `FRONTEND_URL` — links in the emails, with no trailing slash added.

Every attempt is written to `email_log` with status `sent`, `failed`, or `skipped`. A missing table or a provider error is recorded and does not fail the request that asked for the email.

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
