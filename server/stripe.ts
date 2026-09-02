import Stripe from 'stripe';

export function stripeMode() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (key.startsWith('sk_live_')) {
    throw new Error('Stripe live keys are disabled. Use Test Mode keys only.');
  }
  if (key.startsWith('sk_test_')) return 'stripe_test' as const;
  return 'local_mock' as const;
}

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key.startsWith('sk_test_')) return null;
  return new Stripe(key);
}
