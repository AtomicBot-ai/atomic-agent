import { chargeCard } from "../src/billing/charge.js";

test("charges", async () => {
  await chargeCard("c1", 100);
});
