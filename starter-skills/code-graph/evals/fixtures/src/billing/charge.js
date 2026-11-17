import { gateway } from "./gateway.js";

export async function chargeCard(customerId, amountCents) {
  if (amountCents <= 0) throw new Error("amount must be positive");
  return gateway.post("/charges", { customerId, amountCents });
}
