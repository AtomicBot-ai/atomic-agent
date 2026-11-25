import { chargeCard } from "../billing/charge.js";
import { loadCart } from "./cart.js";

export async function completeCheckout(req) {
  const cart = await loadCart(req.sessionId);
  const total = cart.items.reduce((sum, item) => sum + item.priceCents, 0);
  const receipt = await chargeCard(req.customerId, total);
  return { receipt, items: cart.items.length };
}
