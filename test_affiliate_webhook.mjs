// Run:  node test_affiliate_webhook.mjs
process.env.SUPABASE_URL = "https://stub.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.STRIPE_SECRET_KEY = "sk_test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec";

let pass = 0, fail = 0;
const check = (n, c) => c ? (pass++, console.log("  ok   " + n))
                          : (fail++, console.log("  FAIL " + n));

let plan = [], calls = [], errs = [];
globalThis.__subs = {}; globalThis.__subUpdates = [];
const realErr = console.error;
console.error = (...a) => errs.push(a.join(" "));

globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || "GET",
               body: opts.body ? JSON.parse(opts.body) : null });
  const p = plan.find(x => String(url).includes(x.match)) || {};
  const status = p.status ?? 200;
  return { ok: status >= 200 && status < 300, status,
           json: async () => p.body ?? [], text: async () => JSON.stringify(p.body ?? "") };
};

// Import the REAL handler with only the Stripe SDK stubbed, so everything
// under test is the file that ships. Stripe is a runtime dependency on Vercel
// and is not installed for this test.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const STRIPE_STUB = `const Stripe = function () {
  return {
    webhooks: { constructEvent: (raw) => JSON.parse(raw.toString()) },
    subscriptions: {
      update: async (id, body) => { globalThis.__subUpdates.push({ id, body }); return {}; },
      retrieve: async (id) => globalThis.__subs[id] || null
    }
  };
};`;
const real = readFileSync(new URL("./api/affiliate-webhook.js", import.meta.url), "utf8");
if (!real.includes('import Stripe from "stripe";')) {
  console.error("the Stripe import moved — this shim is stale"); process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "aw-"));
const copy = join(dir, "aw.mjs");
writeFileSync(copy, real.replace('import Stripe from "stripe";', STRIPE_STUB));
const { default: handler } = await import(copy);

function req(event) {
  const raw = Buffer.from(JSON.stringify(event));
  return { method: "POST", headers: { "stripe-signature": "x" },
           async *[Symbol.asyncIterator]() { yield raw; } };
}
function res() {
  const o = { code: 200, payload: null, sent: null };
  o.status = c => (o.code = c, o);
  o.json = p => (o.payload = p, o);
  o.send = p => (o.sent = p, o);
  o.end = () => o;
  return o;
}
const reset = () => { plan = []; calls = []; errs = []; globalThis.__subs = {}; globalThis.__subUpdates = []; };

const AFF = { id: 1, code: "ROME", status: "active", commission_rate: 0.3, commission_months: 0 };
const INVOICE_EVENT = (over = {}) => ({
  type: "invoice.paid",
  data: { object: { id: "in_1", amount_paid: 10000, customer: "cus_1",
                    customer_email: "a@b.c", created: 1757000000,
                    lines: { data: [{ description: "Pro" }] },
                    parent: { subscription_details: { subscription: "sub_1" } }, ...over } }
});

console.log("1. a Supabase write that FAILS must not report success to Stripe");
reset();
globalThis.__subs.sub_1 = { metadata: { affiliate_code: "ROME", affiliate_visitor: "v1" },
                            start_date: 1756000000 };
plan = [{ match: "affiliates?", body: [AFF] },
        { match: "affiliate_conversions", status: 401, body: { message: "JWT expired" } }];
let r = res(); await handler(req(INVOICE_EVENT()), r);
check("returns 500 so Stripe retries", r.code === 500);
check("does NOT return received:true", !(r.payload && r.payload.received));
check("the failure is logged", errs.some(e => /affiliate webhook error/.test(e)));

console.log("2. the happy path still books the commission");
reset();
globalThis.__subs.sub_1 = { metadata: { affiliate_code: "ROME", affiliate_visitor: "v1" },
                            start_date: 1756000000 };
plan = [{ match: "affiliates?", body: [AFF] }, { match: "affiliate_conversions", status: 201, body: [{}] }];
r = res(); await handler(req(INVOICE_EVENT()), r);
const ins = calls.find(c => c.url.includes("affiliate_conversions") && c.method === "POST");
check("returns received:true", r.payload && r.payload.received === true);
check("commission = 30% of 10000", ins && ins.body.commission_cents === 3000);
check("invoice id carried for dedupe", ins && ins.body.stripe_invoice_id === "in_1");

console.log("3. ILIKE over-match must not credit the wrong affiliate");
reset();
globalThis.__subs.sub_1 = { metadata: { affiliate_code: "ab_", affiliate_visitor: "v1" },
                            start_date: 1756000000 };
// PostgREST returns a DIFFERENT code because `_` matched a wildcard
plan = [{ match: "affiliates?", body: [{ ...AFF, id: 99, code: "abc" }] }];
r = res(); await handler(req(INVOICE_EVENT()), r);
check("no conversion written", !calls.some(c => c.url.includes("affiliate_conversions") && c.method === "POST"));
check("logged as unmatched", errs.some(e => /no ACTIVE affiliate matches/.test(e)));
check("wildcards escaped in the query", calls[0] && /%5C_/i.test(calls[0].url));

console.log("4. an unusable commission_rate refuses rather than booking zero");
reset();
globalThis.__subs.sub_1 = { metadata: { affiliate_code: "ROME", affiliate_visitor: "v1" },
                            start_date: 1756000000 };
plan = [{ match: "affiliates?", body: [{ ...AFF, commission_rate: null }] }];
r = res(); await handler(req(INVOICE_EVENT()), r);
check("returns 500, not a zero commission", r.code === 500);
check("nothing written", !calls.some(c => c.url.includes("affiliate_conversions") && c.method === "POST"));

console.log("5. a stamped code with no active affiliate is reported, not dropped");
reset();
globalThis.__subs.sub_1 = { metadata: { affiliate_code: "GONE" }, start_date: 1756000000 };
plan = [{ match: "affiliates?", body: [] }];
r = res(); await handler(req(INVOICE_EVENT()), r);
check("logged by name", errs.some(e => /"GONE"/.test(e) && /not credited/.test(e)));

console.log("6. the 2025 invoice shape is still read");
reset();
globalThis.__subs.sub_1 = { metadata: { affiliate_code: "ROME" }, start_date: 1756000000 };
plan = [{ match: "affiliates?", body: [AFF] }, { match: "affiliate_conversions", status: 201, body: [{}] }];
r = res(); await handler(req(INVOICE_EVENT({ subscription: undefined })), r);
check("parent.subscription_details.subscription resolved", calls.some(c => c.url.includes("affiliate_conversions")));

console.log("7. a failed refund void also retries");
reset();
plan = [{ match: "affiliate_conversions", status: 500, body: "boom" }];
r = res(); await handler(req({ type: "charge.refunded", data: { object: { invoice: "in_1" } } }), r);
check("returns 500", r.code === 500);

console.error = realErr;
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
