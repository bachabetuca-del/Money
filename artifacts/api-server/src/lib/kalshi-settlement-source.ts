type Market = {
  ticker: string; status?: string; result?: string; is_provisional?: boolean;
  market_type?: string; settlement_value_dollars?: string; notional_value_dollars?: string;
};
export type SettlementValue = { result: string | null; terminal: boolean };

/** Only an official, final, $1 binary contract can enter the $1 payout backtest. */
export function officialSettlement(market: Market): SettlementValue {
  if (!["settled", "finalized"].includes(market.status ?? "") || market.is_provisional === true) {
    return { result: null, terminal: false };
  }
  const binary = ["yes", "no"].includes(market.result ?? "") &&
    (!market.market_type || market.market_type === "binary");
  const expected = market.result === "yes" ? 1 : 0;
  const payout = market.settlement_value_dollars;
  const notional = market.notional_value_dollars;
  const dollars = (s: string) => /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (!binary || (payout !== undefined && dollars(payout) !== expected) ||
    (notional !== undefined && dollars(notional) !== 1)) return { result: "unsupported", terminal: true };
  return { result: market.result!, terminal: true };
}

export type SettlementWrite = SettlementValue & {
  ticker: string; historical: boolean; checkedAt: Date; nextCheckAt: Date; error: string | null;
};
export type SettlementStore = {
  candidates(historical: boolean, limit: number, now: Date): Promise<string[]>;
  save(value: SettlementWrite): Promise<void>;
};
type Request = <T>(path: string) => Promise<T>;

/** Runs only inside the existing singleton production worker. No Telegram effects. */
export class MarketSettlementWorker {
  private busy = false;
  constructor(private store: SettlementStore, private request: Request, private paused: () => boolean) {}

  async tick(now = new Date()) {
    if (this.busy || this.paused()) return;
    this.busy = true;
    try {
      const historical = await this.store.candidates(true, 5, now);
      for (const ticker of historical) {
        if (this.paused()) return;
        try {
          const response = await this.request<{ market: Market }>(`/historical/markets/${encodeURIComponent(ticker)}`);
          if (response.market?.ticker !== ticker) throw new Error("Unexpected market");
          await this.save(ticker, officialSettlement(response.market), true, now);
        } catch {
          await this.save(ticker, { result: null, terminal: false }, true, now, "No se pudo consultar la resolución histórica.");
        }
      }
      if (this.paused()) return;
      const tickers = await this.store.candidates(false, 50, now);
      if (!tickers.length) return;
      let response: { markets: Market[]; cursor?: string };
      try {
        response = await this.request(`/markets?${new URLSearchParams({ tickers: tickers.join(","), limit: "1000" })}`);
        if (!Array.isArray(response.markets) || response.cursor) throw new Error("Incomplete market response");
      } catch (error) {
        for (const ticker of tickers) await this.save(ticker, { result: null, terminal: false }, false, now,
          "No se pudo consultar la resolución de Kalshi.");
        throw error;
      }
      const byTicker = new Map(response.markets.map(m => [m.ticker, m]));
      for (const ticker of tickers) {
        const market = byTicker.get(ticker);
        // Missing from the current database: schedule bounded historical lookups.
        await this.save(ticker, market ? officialSettlement(market) : { result: null, terminal: false },
          !market, now);
      }
    } finally { this.busy = false; }
  }
  private save(ticker: string, value: SettlementValue, historical: boolean, now: Date, error: string | null = null) {
    return this.store.save({
      ticker, ...value, historical, checkedAt: now, error,
      nextCheckAt: new Date(now.getTime() + (error ? 15 * 60_000 : historical && !value.terminal ? 60_000 : 15 * 60_000)),
    });
  }
}
