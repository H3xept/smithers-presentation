import { quote } from "./pricing";

export const routes = {
  "GET /quote": ({ tier, seats }: { tier: string; seats: string }) =>
    quote(tier, Number(seats)),

  "POST /subscribe": ({ tier, seats }: { tier: string; seats: number }) => {
    const q = quote(tier, seats);
    return { subscribed: true, chargedCents: q.total };
  },
};
