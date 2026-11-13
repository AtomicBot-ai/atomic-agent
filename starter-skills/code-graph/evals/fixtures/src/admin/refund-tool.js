// Refunds never go through chargeCard; they use the gateway directly.
import { gateway } from "../billing/gateway.js";

export async function refund(chargeId) {
  const label = "chargeCard reversal";
  return gateway.post(`/charges/${chargeId}/refund`, { label });
}
