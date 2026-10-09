/**
 * The branded HTML body every platform email shares.
 *
 * The emails were bare text: the sender's display name carried the brand and nothing else did, and one of them
 * (the thread share) did not name the product at all. This is one small, table-based layout that mail clients
 * render reliably: the product name as the header, the message, an optional one-time code or button, and the
 * product's tagline as the footer. Name and tagline come from the deployment profile, so a rebrand reaches
 * the inbox with no edit here. Pure and dependency-free so the tests can render it; every value is escaped.
 * The plain-text part is always sent alongside.
 */
import { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } from "./deployment-profile.generated.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface BrandedEmail {
  /** One line above the message, e.g. "Sign in to Desk A". */
  heading: string;
  paragraphs: string[];
  /** A one-time code, shown large and spaced. */
  code?: string;
  /** The one action the email asks for. Only http(s) URLs are rendered as a button. */
  cta?: { label: string; url: string };
  /** Small print under the message. */
  footnote?: string;
}

export function renderBrandedEmail(mail: BrandedEmail): string {
  const tagline = fillProfileText(DEPLOYMENT_PROFILE.product.tagline);
  const button =
    mail.cta && /^https?:\/\//i.test(mail.cta.url)
      ? `<tr><td style="padding:8px 0 4px"><a href="${esc(mail.cta.url)}" style="display:inline-block;background:#1f1f1f;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">${esc(mail.cta.label)}</a></td></tr>
         <tr><td style="padding:6px 0 0;font-size:12px;color:#6b6b6b;word-break:break-all">Or open this link: ${esc(mail.cta.url)}</td></tr>`
      : "";
  const code = mail.code
    ? `<tr><td style="padding:10px 0 6px"><div style="display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:700;color:#1f1f1f;background:#f3f3f1;border-radius:8px;padding:12px 18px">${esc(mail.code)}</div></td></tr>`
    : "";
  const paragraphs = mail.paragraphs
    .filter((p) => p.trim())
    .map((p) => `<tr><td style="padding:0 0 12px;font-size:15px;line-height:1.55;color:#2b2b2b">${esc(p)}</td></tr>`)
    .join("");
  const footnote = mail.footnote
    ? `<tr><td style="padding:14px 0 0;font-size:12px;line-height:1.5;color:#6b6b6b">${esc(mail.footnote)}</td></tr>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e6e6e2;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td style="padding:22px 28px 0;font-size:17px;font-weight:700;color:#1f1f1f;letter-spacing:-0.01em">${esc(PRODUCT_NAME)}</td></tr>
<tr><td style="padding:18px 28px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:0 0 12px;font-size:19px;font-weight:600;color:#1f1f1f">${esc(mail.heading)}</td></tr>
${paragraphs}${code}${button}${footnote}
</table></td></tr>
<tr><td style="padding:14px 28px 18px;border-top:1px solid #eeeeea;font-size:12px;color:#8a8a86">${esc(PRODUCT_NAME)}${tagline ? ` — ${esc(tagline)}` : ""}</td></tr>
</table></td></tr></table></body></html>`;
}
