// Run:  node test_auth_pages.mjs
// WO site auth pages, Part B. Runs the REAL auth/ff-auth.js against a DOM
// stub and a stubbed supabase client (no network), plus static checks on
// the shipped HTML files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => c ? (pass++, console.log("  ok   " + n))
                          : (fail++, console.log("  FAIL " + n));

const AUTH_PAGES = ["portal.html", "signup.html", "auth/confirm.html", "reset-password.html",
                    "update-password.html", "account.html"];
const SRC = read("auth/ff-auth.js");

// ── harness ──────────────────────────────────────────────────────────────
function load(overrides = {}) {
  const logs = [];
  const spy = (...a) => logs.push(a.map(String).join(" "));
  const ctx = vm.createContext({ atob, URLSearchParams, encodeURIComponent,
                                 console: { log: spy, warn: spy, error: spy, info: spy, debug: spy } });
  vm.runInContext(SRC, ctx);
  Object.assign(ctx.FFAuth.CONFIG, overrides);
  return { FF: ctx.FFAuth, logs };
}

function makeDoc() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: "", checked: false, textContent: "", hidden: false,
      disabled: false, href: "", className: "", listeners: {},
      addEventListener(t, f) { this.listeners[t] = f; },
      fire(t) { return this.listeners[t]({ preventDefault() {} }); } });
    return els.get(id);
  };
  return { getElementById: el, els };
}

function makeSb(plan = {}) {
  const calls = [];
  const rec = (name, ret) => async (...a) => { calls.push({ name, args: a }); return typeof ret === "function" ? ret(...a) : ret; };
  const sb = {
    calls,
    auth: {
      signInWithPassword: rec("signInWithPassword", plan.signIn ?? { data: { session: null }, error: { message: "Invalid login credentials" } }),
      signUp: rec("signUp", plan.signUp ?? { data: { user: { identities: [{}] } }, error: null }),
      verifyOtp: rec("verifyOtp", plan.verifyOtp ?? { data: { session: { access_token: "x" } }, error: null }),
      resetPasswordForEmail: rec("resetPasswordForEmail", plan.reset ?? { data: {}, error: null }),
      resend: rec("resend", { data: {}, error: null }),
      getSession: rec("getSession", plan.getSession ?? { data: { session: null } }),
      updateUser: rec("updateUser", plan.updateUser ?? { data: {}, error: null }),
      signOut: rec("signOut", { error: null })
    },
    from(table) {
      const q = { table, filters: [] };
      calls.push({ name: "from", args: [table], q });
      const chain = {
        select(cols) { q.cols = cols; return chain; },
        eq(k, v) { q.filters.push([k, v]); return chain; },
        async maybeSingle() { return plan.customer ?? { data: null, error: null }; }
      };
      return chain;
    }
  };
  return sb;
}

function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k), m };
}

function env(sb, extra = {}) {
  const navs = [], urls = [];
  return Object.assign({ doc: makeDoc(), sb, nav: (u) => navs.push(u), navs,
                         replaceUrl: (u) => urls.push(u), urls, storage: makeStorage(),
                         clipboard: { written: [], async writeText(t) { this.written.push(t); } } }, extra);
}

const jwt = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const flush = () => new Promise((r) => setTimeout(r, 0));
const domText = (doc) => [...doc.els.values()].map((e) => [e.textContent, e.value, e.href].join("|")).join("\n");

// ── portal ───────────────────────────────────────────────────────────────
console.log("1. /portal");
{
  const { FF } = load();
  const sb = makeSb({ signIn: { data: { session: { access_token: "t" } }, error: null } });
  const e = env(sb);
  FF.boot("portal", e);
  e.doc.getElementById("email").value = "a@b.co";
  e.doc.getElementById("password").value = "pw123456";
  await e.doc.getElementById("form").fire("submit");
  check("good login → /account", e.navs[0] === "/account");
}
{
  const texts = [];
  for (const plan of [{ signIn: { data: { session: null }, error: { message: "Invalid login credentials" } } },
                      { signIn: { data: { session: null }, error: { message: "Email not confirmed" } } }]) {
    const { FF } = load();
    const e = env(makeSb(plan));
    FF.boot("portal", e);
    e.doc.getElementById("email").value = "who@b.co";
    e.doc.getElementById("password").value = "wrong-pw";
    await e.doc.getElementById("form").fire("submit");
    texts.push(e.doc.getElementById("msg").textContent);
    check("failed login stays on the page", e.navs.length === 0);
  }
  check("bad password and unknown/unconfirmed email give the same text", texts[0] === texts[1] && texts[0].length > 0);
  check("the failure text does not echo the server message", !/credentials|confirmed/i.test(texts[0]));
}

// ── signup ───────────────────────────────────────────────────────────────
console.log("2. /signup");
{
  const { FF } = load();
  const e = env(makeSb());
  FF.boot("signup", e);
  check("closed by default (SIGNUP_OPEN false): form hidden, no signUp", e.doc.getElementById("form").hidden === true
        && e.sb.calls.length === 0 && e.doc.getElementById("msg").textContent === FF.TEXT.signupClosed);
}
async function doSignup(plan, fill) {
  const { FF } = load({ SIGNUP_OPEN: true });
  const e = env(makeSb(plan));
  FF.boot("signup", e);
  const d = e.doc;
  Object.assign(d.getElementById("email"), { value: "new@b.co" });
  Object.assign(d.getElementById("password"), { value: "longenough1" });
  Object.assign(d.getElementById("name"), { value: "Pat" });
  Object.assign(d.getElementById("ack"), { checked: true });
  if (fill) fill(d);
  await d.getElementById("form").fire("submit");
  return { FF, e };
}
{
  const { FF, e } = await doSignup();
  const c = e.sb.calls.find((x) => x.name === "signUp");
  check("signUp called once", !!c);
  check("emailRedirectTo is exactly https://futuresforged.com/auth/confirm",
        c && c.args[0].options.emailRedirectTo === "https://futuresforged.com/auth/confirm");
  check("then 'Check your email'", e.doc.getElementById("msg").textContent === FF.TEXT.signupSent);
  const newText = e.doc.getElementById("msg").textContent;
  const r2 = await doSignup({ signUp: { data: { user: { identities: [] } }, error: null } });
  check("existing email (fake user, identities = []) shows exactly the new-account text",
        r2.e.doc.getElementById("msg").textContent === newText);
}
for (const [name, fill] of [["no ack", (d) => { d.getElementById("ack").checked = false; }],
                            ["short password", (d) => { d.getElementById("password").value = "short"; }],
                            ["bad email", (d) => { d.getElementById("email").value = "nope"; }],
                            ["no name", (d) => { d.getElementById("name").value = " "; }]]) {
  const { e } = await doSignup(undefined, fill);
  check(name + " → nothing sent", !e.sb.calls.some((x) => x.name === "signUp"));
}

// ── confirm ──────────────────────────────────────────────────────────────
console.log("3. /auth/confirm");
const TOKEN = "pkce_9f8e7d6c5b4a39281706";
async function doConfirm(type, plan, click = true) {
  const { FF, logs } = load();
  const e = env(makeSb(plan), { search: "?token_hash=" + TOKEN + "&type=" + type });
  FF.boot("confirm", e);
  const loadCalls = e.sb.calls.filter((x) => x.name === "verifyOtp").length;
  if (click) await e.doc.getElementById("confirm").listeners.click?.();
  return { FF, e, logs, loadCalls };
}
{
  const r = await doConfirm("signup", undefined, false);
  check("verifyOtp is NOT called on page load", r.loadCalls === 0 && r.e.doc.getElementById("confirm").hidden === false);
  check("the token is removed from the address bar on load", r.e.urls[0] === "/auth/confirm");
}
{
  const r = await doConfirm("signup");
  const c = r.e.sb.calls.find((x) => x.name === "verifyOtp");
  check("click → verifyOtp({token_hash, type})", c && c.args[0].token_hash === TOKEN && c.args[0].type === "signup");
  check("signup → confirmed text", r.e.doc.getElementById("msg").textContent === r.FF.TEXT.confirmed);
  check("token never in the DOM or a log", !domText(r.e.doc).includes(TOKEN) && !r.logs.join("\n").includes(TOKEN));
}
{
  const r = await doConfirm("email_change");
  check("email_change → confirmed text", r.e.doc.getElementById("msg").textContent === r.FF.TEXT.confirmed);
}
{
  const r = await doConfirm("recovery");
  check("recovery → sets the one-shot flag and goes to /update-password",
        r.e.navs[0] === "/update-password" && r.e.storage.getItem(r.FF.RECOVERY_FLAG) === "1");
}
{
  const r = await doConfirm("recovery", { verifyOtp: { data: null, error: { message: "Token has expired or is invalid" } } });
  check("bad token → expired text, no flag, resend shown", r.e.doc.getElementById("msg").textContent === r.FF.TEXT.expired
        && r.e.storage.getItem(r.FF.RECOVERY_FLAG) === null && r.e.doc.getElementById("resend").hidden === false);
  check("expired text does not echo the server message", !/Token has expired or is invalid/.test(domText(r.e.doc)));
}
{
  const r = await doConfirm("magiclink", undefined, false);
  check("an unknown type → expired text, no button", r.e.doc.getElementById("confirm").hidden === true
        && r.e.doc.getElementById("msg").textContent === r.FF.TEXT.expired);
}
{
  const r = await doConfirm("signup", { verifyOtp: { data: null, error: { message: "x" } } });
  r.e.doc.getElementById("resend-email").value = "new@b.co";
  await r.e.doc.getElementById("resend-form").fire("submit");
  const c = r.e.sb.calls.find((x) => x.name === "resend");
  check("send a new one → resend signup with the /auth/confirm redirect, generic text",
        c && c.args[0].type === "signup" && c.args[0].options.emailRedirectTo === "https://futuresforged.com/auth/confirm"
        && r.e.doc.getElementById("msg").textContent === r.FF.TEXT.resendSent);
}

// ── reset ────────────────────────────────────────────────────────────────
console.log("4. /reset-password");
{
  const texts = [];
  for (const plan of [{ reset: { data: {}, error: null } }, { reset: { data: null, error: { message: "User not found" } } }]) {
    const { FF } = load();
    const e = env(makeSb(plan));
    FF.boot("reset", e);
    e.doc.getElementById("email").value = "x@b.co";
    await e.doc.getElementById("form").fire("submit");
    const c = e.sb.calls.find((x) => x.name === "resetPasswordForEmail");
    check("resetPasswordForEmail redirectTo = /auth/confirm", c && c.args[1].redirectTo === "https://futuresforged.com/auth/confirm");
    texts.push(e.doc.getElementById("msg").textContent);
  }
  check("same text whether the email exists or not", texts[0] === texts[1] && !/not found/i.test(texts[1]));
}

// ── update-password ──────────────────────────────────────────────────────
console.log("5. /update-password");
const RECOVERY = { data: { session: { access_token: jwt({ amr: [{ method: "otp", timestamp: 1 }] }), user: { id: "u1" } } } };
const NORMAL = { data: { session: { access_token: jwt({ amr: [{ method: "password", timestamp: 1 }] }), user: { id: "u1" } } } };
async function doUpdate(plan, flag, p1, p2) {
  const { FF } = load();
  const e = env(makeSb(plan));
  if (flag) e.storage.setItem(FF.RECOVERY_FLAG, "1");
  await FF.boot("update-password", e);
  e.doc.getElementById("password").value = p1;
  e.doc.getElementById("password2").value = p2;
  if (e.doc.getElementById("form").listeners.submit) await e.doc.getElementById("form").fire("submit");
  return { FF, e };
}
{
  const r = await doUpdate({ getSession: NORMAL }, true, "newpassword1", "newpassword1");
  check("a normal (password) session is refused even with the flag", !r.e.sb.calls.some((x) => x.name === "updateUser")
        && r.e.doc.getElementById("msg").textContent === r.FF.TEXT.noRecovery);
}
{
  const r = await doUpdate({ getSession: RECOVERY }, false, "newpassword1", "newpassword1");
  check("a recovery session without the one-shot flag is refused", !r.e.sb.calls.some((x) => x.name === "updateUser"));
}
{
  const r = await doUpdate({ getSession: { data: { session: null } } }, true, "newpassword1", "newpassword1");
  check("no session is refused", !r.e.sb.calls.some((x) => x.name === "updateUser"));
}
{
  const r = await doUpdate({ getSession: RECOVERY }, true, "newpassword1", "newpassword2");
  check("mismatch → nothing sent", !r.e.sb.calls.some((x) => x.name === "updateUser") && r.e.doc.getElementById("msg").textContent === r.FF.TEXT.mismatch);
}
{
  const r = await doUpdate({ getSession: RECOVERY }, true, "short", "short");
  check("too short → nothing sent", !r.e.sb.calls.some((x) => x.name === "updateUser"));
}
{
  const r = await doUpdate({ getSession: RECOVERY }, true, "newpassword1", "newpassword1");
  const u = r.e.sb.calls.find((x) => x.name === "updateUser");
  const so = r.e.sb.calls.find((x) => x.name === "signOut");
  check("success → updateUser({password}) then local sign-out", u && u.args[0].password === "newpassword1"
        && so && so.args[0].scope === "local" && r.e.doc.getElementById("msg").textContent === r.FF.TEXT.passwordSet);
  check("the one-shot flag is cleared on use", r.e.storage.getItem(r.FF.RECOVERY_FLAG) === null);
}

// ── account ──────────────────────────────────────────────────────────────
console.log("6. /account");
const KEY = "FF-AB12CD34-EF56GH78";
const SIGNED = { data: { session: { access_token: jwt({ amr: [{ method: "password" }] }), user: { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", email: "pat@b.co" } } } };
async function doAccount(cust, cfg = {}) {
  const { FF, logs } = load(cfg);
  const e = env(makeSb({ getSession: SIGNED, customer: { data: cust, error: null } }));
  await FF.boot("account", e);
  return { FF, e, logs };
}
{
  const { FF } = load();
  const e = env(makeSb({ getSession: { data: { session: null } } }));
  await FF.boot("account", e);
  check("signed out → /portal", e.navs[0] === "/portal");
}
{
  const r = await doAccount({ status: "active", tier: "pro", license_key: KEY, expires_at: null, stripe_cust_id: "cus_1" });
  const q = r.e.sb.calls.find((x) => x.name === "from");
  check("reads only its own customers row (id = auth uid)", q && q.args[0] === "customers"
        && q.q.filters.length === 1 && q.q.filters[0][0] === "id" && q.q.filters[0][1] === SIGNED.data.session.user.id);
  const keyEl = r.e.doc.getElementById("acct-key");
  check("the key is masked by default", keyEl.textContent !== KEY && keyEl.textContent.endsWith("GH78"));
  r.e.doc.getElementById("key-show").listeners.click();
  check("show reveals it", keyEl.textContent === KEY);
  await r.e.doc.getElementById("key-copy").listeners.click();
  check("copy writes it to the clipboard", r.e.clipboard.written[0] === KEY);
  const hrefs = [...r.e.doc.els.values()].map((x) => x.href).join(" ") + " " + r.e.navs.join(" ") + r.e.urls.join(" ");
  check("the key is never in a URL or a log", !hrefs.includes(KEY) && !r.logs.join("\n").includes(KEY));
  check("paid: Manage plan shown, Buy hidden", r.e.doc.getElementById("manage").hidden === false && r.e.doc.getElementById("buy").hidden === true);
  check("plan text", r.e.doc.getElementById("acct-plan").textContent === "Active (pro)");
}
{
  const r = await doAccount({ status: "pending", tier: null, license_key: null, expires_at: null, stripe_cust_id: null });
  check("BUY_OPEN false (default): no Buy button", r.e.doc.getElementById("buy").hidden === true);
}
{
  const r = await doAccount({ status: "pending", tier: null, license_key: null, expires_at: null, stripe_cust_id: null }, { BUY_OPEN: true });
  const a = r.e.doc.getElementById("buy-0").href;
  const uid = SIGNED.data.session.user.id;
  check("BUY_OPEN: Buy carries client_reference_id = the auth uid", r.e.doc.getElementById("buy").hidden === false
        && a === "https://buy.stripe.com/7sY8wPc2y5l17LFf0c08g02?client_reference_id=" + uid);
  check("no email in the Buy URL", !/pat@b\.co|pat%40b\.co|prefilled_email/.test(a + r.e.doc.getElementById("buy-1").href));
  check("unpaid: no Manage plan", r.e.doc.getElementById("manage").hidden === true);
}
{
  const { FF } = load();
  const e = env(makeSb({ getSession: SIGNED, customer: { data: { status: "active", license_key: KEY } } }));
  await FF.boot("account", e);
  await e.doc.getElementById("signout").listeners.click();
  check("sign out → signOut() then /portal", e.sb.calls.some((x) => x.name === "signOut") && e.navs.at(-1) === "/portal");
}

// ── static checks on the shipped files ───────────────────────────────────
console.log("7. every auth page");
const CDN = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@(\d+\.\d+\.\d+)\/dist\/umd\/supabase\.js" integrity="sha384-[A-Za-z0-9+\/=]{64}" crossorigin="anonymous"><\/script>/;
for (const p of AUTH_PAGES) {
  const h = read(p);
  check(p + ": noindex", /<meta name="robots" content="noindex">/.test(h));
  check(p + ": supabase-js pinned to an exact version with SRI + crossorigin", CDN.test(h));
  check(p + ": no-referrer", /<meta name="referrer" content="no-referrer">/.test(h));
  check(p + ": no analytics beacon (it would see the URL)", !/cloudflareinsights|googletagmanager|gtag\(/.test(h));
  check(p + ": loads /auth/ff-auth.js and boots", /<script src="\/auth\/ff-auth\.js"><\/script>/.test(h) && /FFAuth\.boot\("[a-z-]+"\)/.test(h));
}
for (const p of [...AUTH_PAGES, "auth/ff-auth.js"]) {
  const h = read(p);
  check(p + ": publishable key only (no service_role / sb_secret)", !/service_role|sb_secret_/.test(h));
}
check("ff-auth.js: no console output at all", !/console\./.test(SRC));
const pins = new Set(AUTH_PAGES.map((p) => (read(p).match(CDN) || [])[1]));
check("every page pins the same supabase-js version", pins.size === 1);

console.log("8. index.html");
const idx = read("index.html");
check("Login → /portal", /<a href="\/portal">Login<\/a>/.test(idx) && !/portal\.html/.test(idx));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
