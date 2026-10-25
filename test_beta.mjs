// Run:  node test_beta.mjs
// WO-138: the /beta sign-up page. Runs the page's own script against a small
// DOM stub and a stubbed fetch, so nothing is sent anywhere.
import fs from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const check = (n, c) => c ? (pass++, console.log("  ok   " + n))
                          : (fail++, console.log("  FAIL " + n));

const html = fs.readFileSync(new URL("./beta.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const COLS = ["full_name", "email", "experience", "instruments", "prop_firms", "automation_use", "goals"];

function page(fields, opts = {}) {
  const els = {}, firms = [];
  const el = (id, extra = {}) => (els[id] = Object.assign({
    id, value: "", checked: false, disabled: false, textContent: "", style: {},
    classList: { _h: new Set(), toggle(c, on) { on ? this._h.add(c) : this._h.delete(c); } },
    _handlers: {}, addEventListener(t, f) { this._handlers[t] = f; }
  }, extra));
  ["beta-form", "b-ok", "b-err", "b-submit", "b-name", "b-email", "b-discord", "b-computer",
   "b-experience", "b-platform", "b-platform-other", "b-futures", "b-account", "b-broker",
   "b-firm-other", "b-hours", "b-why", "b-website", "b-ack", "b-firm-other-box",
   "b-platform-other-wrap", "b-broker-wrap", "b-firms-wrap"].forEach(id => el(id));
  for (const f of ["Lucid", "Topstep", "other"]) firms.push({ value: f, checked: false });
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "boolean") els[k].checked = v; else els[k].value = v;
  }
  for (const f of opts.firms || []) firms.find(x => x.value === f).checked = true;
  const calls = [];
  const ctx = {
    document: {
      getElementById: id => els[id],
      querySelectorAll: sel => sel === "#b-firms input:checked" ? firms.filter(f => f.checked) : []
    },
    fetch: async (url, o) => { calls.push({ url, o }); return { ok: opts.ok !== false, status: opts.ok === false ? 500 : 201 }; },
    window: {}, console
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const submit = async () => { await els["beta-form"]._handlers.submit({ preventDefault() {} }); };
  return { els, calls, submit, api: ctx.window.FFBeta };
}

const FULL = {
  "b-name": "Ada Trader", "b-email": "ada@example.com", "b-discord": "ada#1",
  "b-computer": "mac_intel", "b-experience": "1-3", "b-platform": "other", "b-platform-other": "Sierra",
  "b-futures": "MNQ-NQ", "b-account": "both", "b-broker": "AMP", "b-firm-other-box": true,
  "b-firm-other": "SomeFirm", "b-hours": "3-5", "b-why": "test the copier", "b-ack": true
};

console.log("full submission");
{
  const p = page(FULL, { firms: ["Lucid", "other"] });
  await p.submit();
  check("one POST", p.calls.length === 1);
  const c = p.calls[0];
  check("to beta_applications only", c.url.endsWith("/rest/v1/beta_applications"));
  check("Prefer return=minimal, no read-back", c.o.headers.Prefer === "return=minimal");
  const body = JSON.parse(c.o.body);
  check("exactly the 7 columns (no id / created_at / status)",
        JSON.stringify(Object.keys(body).sort()) === JSON.stringify([...COLS].sort()));
  check("name/email/experience/instruments mapped",
        body.full_name === "Ada Trader" && body.email === "ada@example.com" &&
        body.experience === "1-3" && body.instruments === "MNQ-NQ");
  const pf = JSON.parse(body.prop_firms), au = JSON.parse(body.automation_use), g = JSON.parse(body.goals);
  check("prop_firms JSON parses back", pf.account === "both" && pf.broker === "AMP" &&
        JSON.stringify(pf.firms) === '["Lucid"]' && pf.firms_other === "SomeFirm");
  check("automation_use JSON parses back", au.platform === "other" && au.platform_other === "Sierra" &&
        au.computer === "mac_intel" && au.hours === "3-5");
  check("goals carries why, discord and the consent record (D1)",
        g.why === "test the copier" && g.discord === "ada#1" && g.ack === true && g.ack_v === "beta-ack-v1");
  check("success state shown", p.els["b-ok"].style.display === "block" && p.els["beta-form"].style.display === "none");
}

console.log("only name, email and the acknowledgement are required");
{
  const p = page({ "b-name": "Bo", "b-email": "bo@example.com", "b-ack": true });
  await p.submit();
  check("minimal answers are sent", p.calls.length === 1);
  const body = JSON.parse(p.calls[0].o.body);
  check("empty optional answers do not break the JSON", JSON.parse(body.prop_firms).firms.length === 0);
}

console.log("blocked submissions send nothing");
for (const [name, fields] of [
  ["missing name", { ...FULL, "b-name": "" }],
  ["bad email", { ...FULL, "b-email": "not-an-email" }],
  ["no acknowledgement", { ...FULL, "b-ack": false }],
  ["name over 200", { ...FULL, "b-name": "x".repeat(201) }],
  ["why over 500", { ...FULL, "b-why": "y".repeat(501) }],
]) {
  const p = page(fields);
  await p.submit();
  check(name + ": no POST, error shown", p.calls.length === 0 && p.els["b-err"].style.display === "block");
}
{
  const p = page({ ...FULL, "b-website": "http://spam" });
  await p.submit();
  check("honeypot: no POST, looks done", p.calls.length === 0 && p.els["b-ok"].style.display === "block");
}

console.log("hidden branches are not sent");
{
  const p = page({ ...FULL, "b-account": "prop", "b-platform": "ninjatrader" }, { firms: ["Topstep"] });
  await p.submit();
  const body = JSON.parse(p.calls[0].o.body);
  check("broker dropped when the account is prop only", JSON.parse(body.prop_firms).broker === "");
  check("platform_other dropped unless platform is other", JSON.parse(body.automation_use).platform_other === "");
}

console.log("a failed POST");
{
  const p = page(FULL, { ok: false });
  await p.submit();
  check("error shown, button re-enabled", p.els["b-err"].style.display === "block" && p.els["b-submit"].disabled === false);
}

console.log("page");
check("noindex until Tom approves", /<meta name="robots" content="noindex">/.test(html));
check("does not link the dead footer Privacy Policy", !/Privacy Policy/.test(html));
check("simulated / not financial advice disclosure", /simulated, not live trading/.test(html) && /nothing on this page is financial advice/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
