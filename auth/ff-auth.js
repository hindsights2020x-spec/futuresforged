/* ============================================================
   FuturesForged site auth (WO site auth pages, Part B).
   One classic script shared by /portal, /signup, /auth/confirm,
   /reset-password, /update-password and /account. Each page calls
   FFAuth.boot("<page>") after supabase-js has loaded.

   Rules (WO Part B):
   - publishable key only; RLS limits a signed-in user to their own
     customers row (auth.uid() = id);
   - generic messages, so no page tells whether an email has an account;
   - no token or email in any URL this script builds, and nothing
     secret goes to the console;
   - /signup and the /account Buy buttons stay off until the
     stripe-webhook client_reference_id fix (Part A2) is deployed:
     flip SIGNUP_OPEN / BUY_OPEN only then, on Tom's word.
   ============================================================ */
(function (root) {
  "use strict";

  var CONFIG = {
    SUPABASE_URL: "https://osxwkgmjwtdyvqwlfyre.supabase.co",
    SUPABASE_KEY: "sb_publishable_6Rz0VGoqTeBzVwNMs0vcCg_ev34l8kb",
    SITE: "https://futuresforged.com",
    MIN_PASSWORD: 8,
    SIGNUP_OPEN: false,
    BUY_OPEN: false,
    // Stripe payment links from index.html #pricing.
    PLANS: [
      { name: "Pro", price: "$99/mo", url: "https://buy.stripe.com/7sY8wPc2y5l17LFf0c08g02" },
      { name: "Desk", price: "$199/mo", url: "https://buy.stripe.com/fZu28r8Qm4gXfe7f0c08g03" }
    ],
    // Stripe customer-portal login link (Stripe dashboard > Billing > Customer
    // portal). Empty = "Manage plan" mails support instead.
    BILLING_PORTAL_URL: "",
    SUPPORT: "support@futuresforged.com",
    DOWNLOAD: "https://get.futuresforged.com/FuturesForged.exe"
  };

  var TEXT = {
    signinFailed: "That email and password did not match. Check them, or reset your password.",
    signupSent: "Check your email to confirm your account. If you do not see it in a few minutes, look in spam.",
    signupClosed: "Sign-up opens soon. To join now, email support@futuresforged.com.",
    resetSent: "If that email has an account, a link is on its way. It works once and expires within an hour.",
    resendSent: "If that email has an account, a new link is on its way.",
    confirmed: "Email confirmed. Open FuturesForged and sign in.",
    expired: "This link has expired or was already used.",
    noRecovery: "Open the link from your password reset email again to set a new password.",
    passwordSet: "Password set. You can sign in on the app now.",
    mismatch: "The two passwords do not match.",
    tooShort: "Use at least " + CONFIG.MIN_PASSWORD + " characters.",
    badEmail: "Enter a valid email address.",
    needName: "Enter your name.",
    needAck: "Tick the box to confirm you have read the risk disclaimer.",
    network: "Could not reach the server. Check your connection and try again.",
    noAccount: "No account details were found for this sign-in. Email support@futuresforged.com."
  };

  var RECOVERY_FLAG = "ff_recovery_ok";
  var CONFIRM_TYPES = { signup: 1, email: 1, email_change: 1, recovery: 1 };

  function client() {
    return root.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
  }

  function validEmail(s) {
    return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
  }

  function say(env, text, kind) {
    var m = env.doc.getElementById("msg");
    m.textContent = text;
    m.className = "msg" + (kind ? " " + kind : "");
    m.hidden = false;
  }

  function busy(env, on) {
    var b = env.doc.getElementById("submit");
    if (b) b.disabled = !!on;
  }

  // JWT payload, read only to look at "amr"; never logged.
  function jwtClaims(token) {
    try {
      var p = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      return JSON.parse(root.atob(p));
    } catch (e) { return null; }
  }

  function isRecoverySession(session) {
    if (!session || !session.access_token) return false;
    var c = jwtClaims(session.access_token);
    if (!c || !Array.isArray(c.amr)) return false;
    return c.amr.some(function (a) {
      var m = a && (a.method || a);
      return m === "recovery" || m === "otp";
    });
  }

  function maskKey(key) {
    if (!key) return "";
    var tail = key.slice(-4);
    return key.slice(0, 3) + key.slice(3, -4).replace(/[^-]/g, "•") + tail;
  }

  function onSubmit(env, fn) {
    env.doc.getElementById("form").addEventListener("submit", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      return fn();
    });
  }

  // ── /portal: sign in ─────────────────────────────────────────
  function portal(env) {
    onSubmit(env, async function () {
      var email = env.doc.getElementById("email").value.trim();
      var password = env.doc.getElementById("password").value;
      if (!validEmail(email) || !password) { say(env, TEXT.signinFailed, "err"); return; }
      busy(env, true);
      try {
        var r = await env.sb.auth.signInWithPassword({ email: email, password: password });
        if (r.error || !r.data || !r.data.session) { say(env, TEXT.signinFailed, "err"); return; }
        env.nav("/account");
      } catch (e) {
        say(env, TEXT.network, "err");
      } finally { busy(env, false); }
    });
  }

  // ── /signup ──────────────────────────────────────────────────
  function signup(env) {
    if (!CONFIG.SIGNUP_OPEN) {
      env.doc.getElementById("form").hidden = true;
      say(env, TEXT.signupClosed);
      return;
    }
    onSubmit(env, async function () {
      var email = env.doc.getElementById("email").value.trim();
      var password = env.doc.getElementById("password").value;
      var name = env.doc.getElementById("name").value.trim();
      var ack = env.doc.getElementById("ack").checked;
      if (!validEmail(email)) { say(env, TEXT.badEmail, "err"); return; }
      if (!password || password.length < CONFIG.MIN_PASSWORD) { say(env, TEXT.tooShort, "err"); return; }
      if (!name) { say(env, TEXT.needName, "err"); return; }
      if (!ack) { say(env, TEXT.needAck, "err"); return; }
      busy(env, true);
      try {
        // With "Confirm email" ON, an existing email gets a fake user
        // (identities = []) and no error. The answer is never read for
        // that: every outcome shows the same text (WO 7788 C2).
        await env.sb.auth.signUp({
          email: email,
          password: password,
          options: { emailRedirectTo: CONFIG.SITE + "/auth/confirm", data: { full_name: name } }
        });
        env.doc.getElementById("form").hidden = true;
        say(env, TEXT.signupSent, "ok");
      } catch (e) {
        say(env, TEXT.network, "err");
      } finally { busy(env, false); }
    });
  }

  // ── /auth/confirm ────────────────────────────────────────────
  function confirm(env) {
    var q = new root.URLSearchParams(env.search || "");
    var tokenHash = q.get("token_hash");
    var type = q.get("type");
    // The token leaves the address bar and history at once; it is kept in
    // this closure only.
    if (env.replaceUrl) env.replaceUrl("/auth/confirm");
    var go = env.doc.getElementById("confirm");
    var resend = env.doc.getElementById("resend");
    function expired() {
      go.hidden = true;
      resend.hidden = false;
      say(env, TEXT.expired, "err");
    }
    if (!tokenHash || !CONFIRM_TYPES[type]) { expired(); return; }
    // verifyOtp runs on a click only, never on load, so mail link scanners
    // cannot burn the one-time token (WO 7812 n1).
    go.hidden = false;
    go.addEventListener("click", async function () {
      go.disabled = true;
      try {
        var r = await env.sb.auth.verifyOtp({ token_hash: tokenHash, type: type });
        if (r.error || !r.data || (type === "recovery" && !r.data.session)) { expired(); return; }
        if (type === "recovery") {
          env.storage.setItem(RECOVERY_FLAG, "1");
          env.nav("/update-password");
          return;
        }
        go.hidden = true;
        say(env, TEXT.confirmed, "ok");
      } catch (e) {
        go.disabled = false;
        say(env, TEXT.network, "err");
      }
    });
    resendForm(env, type === "recovery" ? "recovery" : "signup");
  }

  // "Send a new one": the same text whatever the result.
  function resendForm(env, kind) {
    var form = env.doc.getElementById("resend-form");
    if (!form) return;
    form.addEventListener("submit", async function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var email = env.doc.getElementById("resend-email").value.trim();
      if (!validEmail(email)) { say(env, TEXT.badEmail, "err"); return; }
      try {
        if (kind === "recovery") {
          await env.sb.auth.resetPasswordForEmail(email, { redirectTo: CONFIG.SITE + "/auth/confirm" });
        } else {
          await env.sb.auth.resend({ type: "signup", email: email,
            options: { emailRedirectTo: CONFIG.SITE + "/auth/confirm" } });
        }
      } catch (e) { /* same answer either way */ }
      form.hidden = true;
      say(env, TEXT.resendSent, "ok");
    });
  }

  // ── /reset-password ──────────────────────────────────────────
  function reset(env) {
    onSubmit(env, async function () {
      var email = env.doc.getElementById("email").value.trim();
      if (!validEmail(email)) { say(env, TEXT.badEmail, "err"); return; }
      busy(env, true);
      try {
        await env.sb.auth.resetPasswordForEmail(email, { redirectTo: CONFIG.SITE + "/auth/confirm" });
      } catch (e) { /* same answer either way */ }
      busy(env, false);
      env.doc.getElementById("form").hidden = true;
      say(env, TEXT.resetSent, "ok");
    });
  }

  // ── /update-password ─────────────────────────────────────────
  // Needs BOTH the one-shot flag /auth/confirm sets after a recovery
  // verifyOtp AND a session whose amr shows a recovery/otp sign-in, so a
  // normal signed-in session cannot change the password here (WO 7812 n2).
  async function updatePassword(env) {
    var form = env.doc.getElementById("form");
    var flag = env.storage.getItem(RECOVERY_FLAG) === "1";
    var session = null;
    try { session = (await env.sb.auth.getSession()).data.session; } catch (e) { session = null; }
    if (!flag || !isRecoverySession(session)) {
      form.hidden = true;
      say(env, TEXT.noRecovery, "err");
      return;
    }
    onSubmit(env, async function () {
      var p1 = env.doc.getElementById("password").value;
      var p2 = env.doc.getElementById("password2").value;
      if (!p1 || p1.length < CONFIG.MIN_PASSWORD) { say(env, TEXT.tooShort, "err"); return; }
      if (p1 !== p2) { say(env, TEXT.mismatch, "err"); return; }
      busy(env, true);
      try {
        var r = await env.sb.auth.updateUser({ password: p1 });
        if (r.error) { say(env, r.error.message ? String(r.error.message) : TEXT.network, "err"); return; }
        env.storage.removeItem(RECOVERY_FLAG);
        await env.sb.auth.signOut({ scope: "local" });
        form.hidden = true;
        say(env, TEXT.passwordSet, "ok");
      } catch (e) {
        say(env, TEXT.network, "err");
      } finally { busy(env, false); }
    });
  }

  // ── /account ─────────────────────────────────────────────────
  function statusText(c) {
    if (!c) return "No plan";
    var s = c.status === "active" ? "Active" : c.status === "pending" ? "Not paid yet" : (c.status || "Unknown");
    var t = c.tier ? " (" + c.tier + ")" : "";
    var e = c.expires_at ? ", until " + String(c.expires_at).slice(0, 10) : "";
    return s + t + e;
  }

  async function account(env) {
    var session = null;
    try { session = (await env.sb.auth.getSession()).data.session; } catch (e) { session = null; }
    if (!session || !session.user) { env.nav("/portal"); return; }
    var d = env.doc;
    var uid = session.user.id;
    d.getElementById("acct-email").textContent = session.user.email || "";
    var c = null;
    try {
      var r = await env.sb.from("customers")
        .select("status,tier,license_key,expires_at,stripe_cust_id")
        .eq("id", uid).maybeSingle();
      c = r.error ? null : r.data;
    } catch (e) { c = null; }
    d.getElementById("acct-plan").textContent = statusText(c);
    if (!c) say(env, TEXT.noAccount);

    var key = c && c.license_key ? c.license_key : "";
    var keyEl = d.getElementById("acct-key");
    var shown = false;
    keyEl.textContent = key ? maskKey(key) : "None yet";
    var show = d.getElementById("key-show");
    var copy = d.getElementById("key-copy");
    show.hidden = copy.hidden = !key;
    show.addEventListener("click", function () {
      shown = !shown;
      keyEl.textContent = shown ? key : maskKey(key);
      show.textContent = shown ? "Hide" : "Show";
    });
    copy.addEventListener("click", async function () {
      try { await env.clipboard.writeText(key); copy.textContent = "Copied"; }
      catch (e) { copy.textContent = "Copy failed"; }
    });

    // Buy: client_reference_id = the auth uid, so the stripe-webhook (A2)
    // activates THIS user whatever email they pay with. No email in the URL.
    var buy = d.getElementById("buy");
    var paid = !!(c && c.stripe_cust_id);
    buy.hidden = true;
    if (CONFIG.BUY_OPEN && !paid) {
      buy.hidden = false;
      CONFIG.PLANS.forEach(function (p, i) {
        var a = d.getElementById("buy-" + i);
        a.href = p.url + "?client_reference_id=" + encodeURIComponent(uid);
        a.textContent = "Subscribe " + p.name + " — " + p.price;
      });
    }
    var manage = d.getElementById("manage");
    manage.hidden = !paid;
    manage.href = CONFIG.BILLING_PORTAL_URL || ("mailto:" + CONFIG.SUPPORT + "?subject=Manage%20my%20plan");
    d.getElementById("download").href = CONFIG.DOWNLOAD;
    d.getElementById("signout").addEventListener("click", async function () {
      try { await env.sb.auth.signOut(); } catch (e) { /* local session goes anyway */ }
      env.nav("/portal");
    });
  }

  var PAGES = { portal: portal, signup: signup, confirm: confirm, reset: reset,
                "update-password": updatePassword, account: account };

  function boot(page, env) {
    env = env || {
      doc: root.document,
      sb: client(),
      nav: function (u) { root.location.assign(u); },
      search: root.location.search,
      replaceUrl: function (u) { root.history.replaceState(null, "", u); },
      storage: root.sessionStorage,
      clipboard: root.navigator.clipboard
    };
    return PAGES[page](env);
  }

  root.FFAuth = { boot: boot, CONFIG: CONFIG, TEXT: TEXT, maskKey: maskKey,
                  isRecoverySession: isRecoverySession, RECOVERY_FLAG: RECOVERY_FLAG };
})(typeof window !== "undefined" ? window : globalThis);
