import { chargeCard } from "../billing/charge.js";

const PLANS = { basic: 900, pro: 2900 };

export async function renewSubscription(sub) {
  const price = PLANS[sub.plan];
  if (!price) return null;
  await chargeCard(sub.customerId, price);
  return { ...sub, renewedAt: Date.now() };
}
