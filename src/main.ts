import manifest from "./appmeta/manifest.json";
import { createScreen, type Element } from "./screen";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/** S&P 500 from Yahoo's chart API: the day's single bar keeps the answer about 1.3 KB. */
const SP500 = "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=1d";
const BITCOIN = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
const POLL_MS = 5 * 60 * 1000;
/** How long each quote stays on screen before the other one replaces it. */
const SWAP_MS = 5000;

const WHITE = "#FFFFFFFF";
const GREEN = "#00FF00FF";
const RED = "#FF2020FF";

interface Quote {
  price: number;
  /** Change, percent: S&P 500 since the previous close, BTC over 24 hours. */
  change: number;
}

interface Ticker {
  name: string;
  /** Decimals of the change. */
  decimals: number;
  load: () => Promise<Quote>;
}

async function json(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const TICKERS: Ticker[] = [
  {
    name: "S&P 500",
    decimals: 2,
    load: async () => {
      const body = (await json(SP500)) as {
        chart: { result: { meta: { regularMarketPrice: number; chartPreviousClose: number } }[] };
      };
      const meta = body.chart.result[0].meta;
      return {
        price: meta.regularMarketPrice,
        change: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
      };
    },
  },
  {
    name: "BTC",
    decimals: 1,
    load: async () => {
      const body = (await json(BITCOIN)) as { bitcoin: { usd: number; usd_24h_change: number } };
      return { price: body.bitcoin.usd, change: body.bitcoin.usd_24h_change };
    },
  },
];

/** A whole number with thousands separators: 68880 → "68,880". */
function thousands(value: number): string {
  const digits = String(Math.round(Math.abs(value)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}

/** The name and the change on the top line, the price large under them; "--" without a quote. */
function frame(ticker: Ticker, quote: Quote | null): Element[] {
  const color = quote === null ? WHITE : quote.change < 0 ? RED : GREEN;
  const change = quote === null ? "--" : `${quote.change < 0 ? "" : "+"}${quote.change.toFixed(ticker.decimals)}%`;
  return [
    { type: "text", id: "name", text: ticker.name, font: "small", color: WHITE, x: 0, y: -1, align: "top_left" },
    { type: "text", id: "change", text: change, font: "small", color, x: 72, y: -1, align: "top_right" },
    {
      type: "text",
      id: "price",
      text: quote === null ? "--" : thousands(quote.price),
      font: "bold",
      color,
      x: 0,
      y: 6,
      align: "top_left",
    },
  ];
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  const quotes: (Quote | null)[] = TICKERS.map(() => null);
  let shown = 0;
  let loading = false;
  let stopped = false;

  const report = (err: unknown) =>
    console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const screen = createScreen(APP, report);
  const redraw = () => screen.show(frame(TICKERS[shown], quotes[shown]));

  // One round of requests at a time, one ticker after the other; a failed one shows "--" until the next round.
  async function poll(): Promise<void> {
    if (loading) return;
    loading = true;
    for (let i = 0; i < TICKERS.length; i++) {
      // A request in flight keeps the app alive: after Back the next one is not started.
      if (stopped) break;
      try {
        quotes[i] = await TICKERS[i].load();
      } catch (err) {
        quotes[i] = null;
        report(err);
      }
    }
    loading = false;
    if (!stopped) redraw();
  }

  redraw();
  void poll();
  const pollTimer = setInterval(() => void poll(), POLL_MS);
  const swapTimer = setInterval(() => {
    shown = (shown + 1) % TICKERS.length;
    redraw();
  }, SWAP_MS);

  // Back leaves the app. Once the timers are cleared and the handler detached, nothing keeps it alive and the device takes the screen back.
  const unbind = listen("input", (event) => {
    if (stopped || event.key !== "back" || event.action !== "short") return;

    stopped = true;
    screen.close();
    clearInterval(pollTimer);
    clearInterval(swapTimer);

    // Not detached from inside the handler itself: with nothing else left the unbind stops the app on the spot, while this handler is still running.
    setTimeout(unbind, 0);
  });
}

main();
