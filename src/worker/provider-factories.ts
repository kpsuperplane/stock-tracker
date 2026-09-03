import { ExaNewsProvider } from "../providers/exa";
import { FallbackNewsProvider } from "../providers/fallback-news";
import { GoogleNewsProvider } from "../providers/google-news";
import { MarketauxNewsProvider } from "../providers/marketaux";
import type { Env } from "./env";

export const newsProviderFor = (env: Env) => {
  const exa = env.EXA_API_KEY ? new ExaNewsProvider(env.EXA_API_KEY) : null;
  const marketaux = env.MARKETAUX_API_TOKEN
    ? new MarketauxNewsProvider(env.MARKETAUX_API_TOKEN)
    : null;
  return exa && marketaux
    ? new FallbackNewsProvider(exa, marketaux)
    : (exa ?? marketaux ?? new GoogleNewsProvider());
};
