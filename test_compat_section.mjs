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
// Tom 2026-11-02 "fix them in this PR": no stale Tradovate / shelved-ES copy anywhere.
ok("no Tradovate anywhere", !/tradovate/i.test(html));
ok("no shelved Momentum Breakout ES", !/Momentum Breakout ES/.test(html) && !/ES FUTURES — LIVE/.test(html));
const items = (html.match(/class="strat-item"/g) || []).length;
const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
ok("strategy count matches the list (" + items + ")", html.includes(words[items] + " strategies.<br>")
   && (html.match(new RegExp("</span> " + items + " LIVE STRATEGIES<", "g")) || []).length === 2
   && html.includes("All " + items + " live strategies"));
ok("no old dashboard-password or .env claim", !/bcrypt|\.env file/.test(html));
ok("no unconfirmed strategy or rule-enforcement claim (Tom: remove them both)",
   !/Box MR London/.test(html) && !/Will it blow my funded account\?/.test(html) && !/exact rules automatically/.test(html)
   && !/rule enforcement|RISK LIMITS ENFORCED|limits enforced|enforced automatically/i.test(html));
ok("no ES left after the ES strategy was removed (audit-api 8806 C1)", !/NQ and ES|\bES on autopilot|Built for NQ and ES/.test(html));
ok("security wording matches the token file (audit-win-2 8802 C1)", !/Other programs and other computers/.test(html)
   && /programs without that key are refused/.test(html) && /best effort/.test(html));
ok("no live daily-loss-cap halt claimed (audit-win-2 8842 C1, audit-api 8845 B1)",
   !/halted for the day|daily (loss )?caps?[^.]*checked against|trailing thresholds/i.test(html)
   && /not yet enforced on live orders/.test(html));
ok("no automatic sizing or single-machine claim (audit-win-2 8887 C1 + n1)",
   !/Never overexpose|auto-switch|scale automatically with your account balance|single machine|one machine per subscription|cannot be cloned/i.test(html)
   && /up to 3 of your machines/.test(html));
ok("regime scanner worded as live (ECHO 8890)", !/1m, 5m, and 15m|pauses trend strategies|> Regime scanner</.test(html)
   && /Momentum Breakout skips new entries while the market reads choppy or low-volatility/.test(html));
ok("live entry = order-flow trigger, no 6-indicator gate (ECHO 8896)", !/6-Indicator|5 of 6 indicators|6-indicator confluence/i.test(html)
   && /<h3>Order-Flow Entry Trigger<\/h3>/.test(html) && /enters on absorption or a confirmed sweep/.test(html));
ok("div tags balance", (html.match(/<div/g) || []).length === (html.match(/<\/div>/g) || []).length);
process.exit(fail ? 1 : 0);
