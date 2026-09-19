// The branded email layout: names the product, escapes everything, only renders an http(s) button.
//   node --conditions=react-server --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-email-html.mjs
import assert from "node:assert/strict";
import { renderBrandedEmail } from "../lib/email-html.ts";
import { PRODUCT_NAME } from "../lib/deployment-profile.generated.ts";

const code = renderBrandedEmail({ heading: `Sign in to ${PRODUCT_NAME}`, paragraphs: ["Enter this code."], code: "123456", footnote: "Expires in 10 minutes." });
assert.ok(code.includes(PRODUCT_NAME), "the product is named");
assert.ok(code.includes("123456") && code.includes("Expires in 10 minutes."));
assert.ok(!code.includes("<a "), "no button without a cta");

const share = renderBrandedEmail({ heading: "Shared", paragraphs: [`<script>alert(1)</script> & "quotes"`], cta: { label: "Open <it>", url: "https://app.example/?chatSession=a&b=1" } });
assert.ok(!share.includes("<script>"), "message text is escaped");
assert.ok(share.includes("&lt;script&gt;") && share.includes("&amp;") && share.includes("&quot;quotes&quot;"));
assert.ok(share.includes('href="https://app.example/?chatSession=a&amp;b=1"'), "the url is escaped inside the attribute");
assert.ok(share.includes("Open &lt;it&gt;"));

const bad = renderBrandedEmail({ heading: "x", paragraphs: ["y"], cta: { label: "go", url: "javascript:alert(1)" } });
assert.ok(!bad.includes("javascript:") && !bad.includes("<a "), "a non-http(s) url never becomes a link");
// The layout itself names nothing but the profile's product: strip every occurrence of it, then nothing of
// the original product's wording may remain (the default profile's name IS "Delivered", hence replaceAll).
assert.ok(!/FDE app|Delivered/.test(renderBrandedEmail({ heading: "h", paragraphs: ["p"] }).replaceAll(PRODUCT_NAME, "")), "no hardcoded product wording in the layout");
console.log("test-email-html: all assertions passed");
