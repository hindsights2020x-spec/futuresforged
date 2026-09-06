// api/affiliate-webhook.js — Vercel serverless function
// Records affiliate conversions from Stripe. Uses the SERVICE ROLE key,
// so it must run server-side only. Never ship this key to the browser.
//
// Env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//           SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Stripe events to subscribe: checkout.session.completed, invoice.paid, charge.refunded

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false } };

const sb = (path, opts = {}) =>
  fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opts.headers || {})
    }
  });

// client_reference_id format written by the site: aff_<CODE>_<visitorId>
const parseRef = (ref) => {
  const m = /^aff_([A-Za-z0-9_-]{3,24})_(.+)$/.exec(ref || "");
  return m ? { code: m[1], visitorId: m[2] } : null;
};

// Stripe moved the subscription pointer off the invoice in the 2025 API
// versions (invoice.parent.subscription_details.subscription). Read either
// shape so the handler works whatever version the endpoint is pinned to.
const invoiceSubscriptionId = (inv) => {
  const s = inv?.subscription ?? inv?.parent?.subscription_details?.subscription;
  return typeof s === "string" ? s : s?.id || null;
};

async function getAffiliate(code) {
  const r = await sb(`affiliates?code=ilike.${encodeURIComponent(code)}&status=eq.active&select=*`);
  const rows = await r.json();
  return rows[0] || null;
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(
      raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Signature check failed: ${err.message}`);
  }

  try {
    // 1. First payment — stamp the affiliate code onto the subscription so
    //    every future invoice can be attributed without the browser.
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const ref = parseRef(s.client_reference_id);
      const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
      if (ref && subId) {
        const aff = await getAffiliate(ref.code);
        if (aff) {
          await stripe.subscriptions.update(subId, {
            metadata: { affiliate_code: aff.code, affiliate_visitor: ref.visitorId }
          });
        }
      }
    }

    // 2. Every paid invoice on an attributed subscription = a commission row.
    if (event.type === "invoice.paid") {
      const inv = event.data.object;
      const subId = invoiceSubscriptionId(inv);
      const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;
      const code = sub?.metadata?.affiliate_code;

      if (code) {
        const aff = await getAffiliate(code);
        if (aff) {
          const start = new Date(sub.start_date * 1000);
          const monthsIn = (Date.now() - start) / 2629800000;
          const withinWindow = aff.commission_months === 0 || monthsIn <= aff.commission_months;

          if (withinWindow) {
            const gross = inv.amount_paid || 0;
            await sb("affiliate_conversions", {
              method: "POST",
              headers: { Prefer: "resolution=ignore-duplicates" },
              body: JSON.stringify({
                code: aff.code,
                affiliate_id: aff.id,
                visitor_id: sub.metadata.affiliate_visitor || null,
                customer_email: inv.customer_email,
                stripe_customer_id: inv.customer,
                stripe_subscription_id: subId,
                stripe_invoice_id: inv.id,                // unique — retries can't double-credit
                plan: inv.lines?.data?.[0]?.description || null,
                gross_cents: gross,
                commission_cents: Math.round(gross * Number(aff.commission_rate)),
                occurred_at: new Date(inv.created * 1000).toISOString(),
                status: "pending"                          // you flip to 'approved' after the refund window
              })
            });
          }
        }
      }
    }

    // 3. Refund voids the commission.
    if (event.type === "charge.refunded") {
      const invId = event.data.object.invoice;
      if (invId) {
        await sb(`affiliate_conversions?stripe_invoice_id=eq.${invId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "refunded" })
        });
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("affiliate webhook error", err);
    return res.status(500).json({ error: "handler failed" });
  }
}
