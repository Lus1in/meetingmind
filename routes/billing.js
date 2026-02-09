const express = require('express');
const db = require('../database');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// ---- Constants ----
const LIFETIME_PRICES = {
  ltd:  { amount: 4900, name: 'MeetingMind LTD' },
  fltd: { amount: 6900, name: 'MeetingMind FLTD' }
};

const SUBSCRIPTION_PRICES = {
  sub_basic: { priceId: process.env.STRIPE_PRICE_BASIC_MONTHLY, name: 'MeetingMind Basic Monthly' },
  sub_pro:   { priceId: process.env.STRIPE_PRICE_PRO_MONTHLY,   name: 'MeetingMind Pro Monthly' }
};

// ---- Helpers ----
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

function isLifetime(user) {
  return user.is_lifetime === 1;
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByStripeCustomer(customerId) {
  return db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
}

// ---- One-Time Checkout (LTD/FLTD) ----
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in .env' });
  }

  const { plan } = req.body;

  if (!plan || !LIFETIME_PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Must be ltd or fltd' });
  }

  const user = getUserById(req.session.userId);
  if (isLifetime(user)) {
    return res.status(400).json({ error: 'You already have a lifetime plan' });
  }

  try {
    const price = LIFETIME_PRICES[plan];
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: price.name },
          unit_amount: price.amount
        },
        quantity: 1
      }],
      metadata: {
        user_id: String(req.session.userId),
        plan: plan,
        type: 'one_time'
      },
      success_url: `${baseUrl}/billing-success.html`,
      cancel_url: `${baseUrl}/billing-cancel.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ---- Subscription Checkout ----
router.post('/create-subscription-session', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in .env' });
  }

  const { plan } = req.body;

  if (!plan || !SUBSCRIPTION_PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Must be sub_basic or sub_pro' });
  }

  const subPrice = SUBSCRIPTION_PRICES[plan];
  if (!subPrice.priceId) {
    return res.status(501).json({ error: `Stripe Price ID not configured for ${plan}` });
  }

  const user = getUserById(req.session.userId);

  // CORE RULE: lifetime users cannot create subscriptions
  if (isLifetime(user)) {
    return res.status(403).json({ error: 'Lifetime members cannot create subscriptions. You already have lifetime access.' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: subPrice.priceId, quantity: 1 }],
      metadata: {
        user_id: String(req.session.userId),
        plan: plan,
        type: 'subscription'
      },
      success_url: `${baseUrl}/billing-success.html`,
      cancel_url: `${baseUrl}/billing-cancel.html`
    };

    // Reuse existing Stripe customer if we have one
    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
    } else {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe subscription error:', err.message);
    res.status(500).json({ error: 'Failed to create subscription session' });
  }
});

// ---- Customer Portal ----
router.post('/portal', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'Stripe not configured' });
  }

  const user = getUserById(req.session.userId);
  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${baseUrl}/account.html`
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ---- Webhook (handles ALL Stripe events) ----
// NOTE: raw body configured in server.js
router.post('/webhook', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set. Run: stripe listen --forward-to localhost:3000/api/billing/webhook  then copy the whsec_... value into .env');
    return res.status(500).json({ error: 'Webhook secret not configured. See server logs.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  switch (event.type) {
    case 'checkout.session.completed':
      handleCheckoutCompleted(event.data.object);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      handleSubscriptionUpdate(event.data.object);
      break;
    case 'customer.subscription.deleted':
      handleSubscriptionDeleted(event.data.object);
      break;
    case 'invoice.payment_failed':
      handlePaymentFailed(event.data.object);
      break;
  }

  res.json({ received: true });
});

// ---- Webhook Handlers ----

function handleCheckoutCompleted(session) {
  const userId = session.metadata?.user_id;
  const plan = session.metadata?.plan;
  const type = session.metadata?.type;

  if (!userId) return;

  // Store stripe_customer_id
  if (session.customer) {
    db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
      .run(String(session.customer), Number(userId));
  }

  if (type === 'one_time' && ['ltd', 'fltd'].includes(plan)) {
    // Only grant lifetime if payment is confirmed
    if (session.payment_status !== 'paid') {
      console.log(`User ${userId} → one_time checkout not yet paid (${session.payment_status}), skipping`);
      return;
    }
    // Lifetime purchase — set plan + is_lifetime flag
    db.prepare('UPDATE users SET plan = ?, is_lifetime = 1 WHERE id = ?')
      .run(plan, Number(userId));
    console.log(`User ${userId} → lifetime ${plan}`);
  }

  if (type === 'subscription') {
    // Guard: never attach subscription to a lifetime user
    const user = getUserById(Number(userId));
    if (user && isLifetime(user)) {
      console.log(`Webhook: skipping sub attach for lifetime user ${userId}`);
      return;
    }
    // Subscription checkout completed — actual plan set by subscription.created/updated handler
    // Store subscription ID if available
    if (session.subscription) {
      db.prepare('UPDATE users SET stripe_subscription_id = ? WHERE id = ?')
        .run(String(session.subscription), Number(userId));
    }
    console.log(`User ${userId} → subscription checkout completed`);
  }
}

function handleSubscriptionUpdate(subscription) {
  const user = getUserByStripeCustomer(subscription.customer);
  if (!user) {
    console.error('Webhook: no user for customer', subscription.customer);
    return;
  }

  // CORE INVARIANT: never overwrite lifetime plans
  if (isLifetime(user)) {
    console.log(`Webhook: skipping sub update for lifetime user ${user.id}`);
    return;
  }

  const status = subscription.status; // active, past_due, canceled, incomplete, etc.

  // Map Stripe price to our plan
  const priceId = subscription.items?.data?.[0]?.price?.id;
  let plan = user.plan;
  if (priceId === process.env.STRIPE_PRICE_BASIC_MONTHLY) plan = 'sub_basic';
  if (priceId === process.env.STRIPE_PRICE_PRO_MONTHLY) plan = 'sub_pro';

  if (status === 'active') {
    db.prepare('UPDATE users SET plan = ?, stripe_subscription_id = ?, subscription_status = ? WHERE id = ?')
      .run(plan, subscription.id, status, user.id);
    console.log(`User ${user.id} → ${plan} (${status})`);
  } else {
    // past_due, incomplete, etc — update status but keep current plan for grace
    db.prepare('UPDATE users SET stripe_subscription_id = ?, subscription_status = ? WHERE id = ?')
      .run(subscription.id, status, user.id);
    console.log(`User ${user.id} → subscription status ${status}`);
  }
}

function handleSubscriptionDeleted(subscription) {
  const user = getUserByStripeCustomer(subscription.customer);
  if (!user) return;

  // CORE INVARIANT: never overwrite lifetime plans
  if (isLifetime(user)) {
    console.log(`Webhook: skipping sub delete for lifetime user ${user.id}`);
    return;
  }

  // Downgrade to free
  db.prepare('UPDATE users SET plan = ?, stripe_subscription_id = NULL, subscription_status = ? WHERE id = ?')
    .run('free', 'canceled', user.id);
  console.log(`User ${user.id} → free (subscription canceled)`);
}

function handlePaymentFailed(invoice) {
  const user = getUserByStripeCustomer(invoice.customer);
  if (!user) return;

  if (isLifetime(user)) return;

  db.prepare('UPDATE users SET subscription_status = ? WHERE id = ?')
    .run('past_due', user.id);
  console.log(`User ${user.id} → past_due (payment failed)`);
}

module.exports = router;
