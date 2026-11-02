// Market strip WO rev 3 Part D: the "What works with FuturesForged" block on the pricing section.
// Run: node test_compat_section.mjs
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
let fail = 0;
const ok = (n, c) => { console.log((c ? "  ok   " : "  FAIL ") + n); if (!c) fail++; };
const m = html.match(/<div class="firm-add" id="compatible"[\s\S]*?<\/div>\s*<\/div>/);
ok("block present once", m && html.split('id="compatible"').length === 2);
const b = m ? m[0] : "";
const pricing = html.indexOf('id="pricing"'), sec = html.indexOf("</section>", pricing);
ok("inside the pricing section", html.indexOf('id="compatible"') > pricing && html.indexOf('id="compatible"') < sec);
ok("prop-firm accounts need Windows + NinjaTrader 8", /Prop-firm accounts:<\/strong> a Windows PC with NinjaTrader&nbsp;8/.test(b));
ok("Mac worded as not yet available", /Mac:<\/strong> not available yet\. Mac support for cash accounts is coming\./.test(b));
ok("no current Mac support claimed", !/Mac (is|works|supported)/i.test(b));
ok("names no firm", !/(Apex|Topstep|MFFU|Tradeify|Lucid|Take Profit|My Funded)/i.test(b));
ok("no unreleased feature listed", !/market strip/i.test(b));
process.exit(fail ? 1 : 0);
