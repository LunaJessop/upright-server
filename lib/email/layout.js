const FOOTER =
  "You received this because you have an Upright account.";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Shared layout for every transactional email.
 * Paragraphs are plain text. The optional action is a single link.
 */
export function renderEmail({ heading, paragraphs = [], action, footnote }) {
  const safeParagraphs = paragraphs.map(
    (paragraph) => `<p style="margin: 0 0 16px; line-height: 1.5;">${escapeHtml(paragraph)}</p>`
  );
  const actionHtml = action
    ? `<p style="margin: 24px 0;"><a href="${escapeHtml(action.href)}" style="display: inline-block; background: #1c1917; color: #faf7f2; text-decoration: none; padding: 12px 18px; border-radius: 6px;">${escapeHtml(action.label)}</a></p>`
    : "";
  const note = footnote
    ? `<p style="margin: 0 0 16px; line-height: 1.5; color: #57534e;">${escapeHtml(footnote)}</p>`
    : "";

  const html = `<!DOCTYPE html>
<html>
  <body style="margin: 0; background: #faf7f2; color: #1c1917; font-family: Georgia, 'Times New Roman', serif;">
    <div style="max-width: 560px; margin: 0 auto; padding: 32px 20px;">
      <p style="margin: 0 0 24px; font-family: sans-serif; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;">Upright</p>
      <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: normal;">${escapeHtml(heading)}</h1>
      ${safeParagraphs.join("\n")}
      ${actionHtml}
      ${note}
      <p style="margin: 32px 0 0; font-family: sans-serif; font-size: 12px; color: #78716c;">${escapeHtml(FOOTER)}</p>
    </div>
  </body>
</html>`;

  const textParts = [heading, "", ...paragraphs];
  if (action) textParts.push("", `${action.label}: ${action.href}`);
  if (footnote) textParts.push("", footnote);
  textParts.push("", FOOTER);
  const text = textParts.join("\n");

  return { html, text };
}

export const EMAIL_FOOTER = FOOTER;
