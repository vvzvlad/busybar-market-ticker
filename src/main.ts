import manifest from "./appmeta/manifest.json";
import { createScreen, type Element } from "./screen";
import { loadValues, type SettingsValues } from "./settings";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/**
 * Yahoo's chart API for one symbol and its day, in 15-minute closes: 96 points and about 9.4 KB of answer for a market
 * open all day (crypto, currencies), 27 points for an exchange's 6.5-hour session. 5-minute closes would be 288 points
 * and 26 KB for a currency, four times the chart's 72 columns, and raise the heap's peak with six tickers from about 85
 * to 92 KiB (emulator).
 */
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const CHART_QUERY = "?range=1d&interval=15m";

/** The ticker list and the minutes between polls of settings.json, for a bar that returns no settings. */
const DEFAULT_TICKERS = "^GSPC=S&P 500, BTC-USD=BTC";
const DEFAULT_POLL_MIN = 5;
/** Tickers past this many are dropped: the back display's table has a row for each. */
const MAX_TICKERS = 6;

/** How long each quote stays on screen before the next one replaces it. */
const SWAP_MS = 5000;
/** How long a ticker the wheel picked stays before the quotes take turns again. */
const HOLD_MS = 30 * 1000;

/** localStorage key of the last good quotes, a Record<symbol, Quote> as JSON. */
const KEPT_KEY = "quotes";

const WHITE = "#FFFFFFFF";
const GREEN = "#00FF00FF";
const RED = "#FF2020FF";
/** Quotes the last request did not bring, kept from an earlier one, are drawn at this brightness. */
const DIM = 0.4;
/** The area under the chart's line is its colour at this brightness. */
const FILL = 0.25;

/** The chart view: the name and the price small on the top line, the chart in the rows from CHART_TOP down. */
const CHART_TOP = 7;
const CHART_H = 16 - CHART_TOP;
const COLUMNS = 72;

/**
 * The back display's table, a row per ticker: the right edges of the price and of the change, a gap off the
 * firmware's status bar, and the top of the first row and the pitch of the rows.
 */
const BACK_PRICE = 104;
const BACK_RIGHT = 145;
const BACK_TOP = 2;
const BACK_ROW = 13;

/** The no-connection picture, the same in every app. */
const OFFLINE = ["! XPM2", "5 5 2 1", ". c none", "r c #FF3030", "r...r", ".r.r.", "..r..", ".r.r.", "r...r"].join("\n");

interface Ticker {
  /** Yahoo Finance symbol: ^GSPC, BTC-USD, EURUSD=X. */
  symbol: string;
  /** Shown small on the front and in the back display's table. */
  label: string;
}

interface Quote {
  price: number;
  /** Change since the previous close, percent. */
  change: number;
  /** Decimals Yahoo gives the price (its priceHint): 2 for most stocks, indices and coins, 4 for currencies, more for coins worth a fraction of a cent. */
  decimals: number;
}

/** What one answer of the chart API brings: the quote, and the day's line for the chart. */
interface Day {
  quote: Quote;
  /** The line's row in each column of the chart, from the session's start to its last close; -1 before the first. */
  line: number[];
}

/**
 * Where a ticker's quote stands: no answer yet in this run, brought by the last request, the last request failed, or
 * Yahoo does not know the symbol (a typo in the settings, not a lost connection).
 */
type Freshness = "waiting" | "live" | "lost" | "unknown";

/** The fields of the chart API's answer the app reads. */
interface ChartAnswer {
  chart: {
    result: {
      meta: {
        regularMarketPrice: number;
        chartPreviousClose: number;
        priceHint: number;
        /** The market's current session, or once it has closed for the day its next one (Tokyo's on a Sunday evening). */
        currentTradingPeriod: { regular: { start: number; end: number } };
        /** The session of the points, by day; missing for a fund's single price and for futures before their session. */
        tradingPeriods?: { start: number; end: number }[][];
      };
      /** Without trades in the day there are no points: no timestamps and no closes (futures before their session). */
      timestamp?: number[];
      indicators: { quote: { close?: (number | null)[] }[] };
    }[];
  };
}

/**
 * The tickers of the settings: Yahoo symbols separated by commas, each optionally SYMBOL=Label, the first MAX_TICKERS.
 * An "=" before a single last letter belongs to the symbol (EURUSD=X, GC=F), so EURUSD=X=EUR/USD labels a currency.
 * Without a label, the symbol up to its suffix: ^GSPC → GSPC, BTC-USD → BTC, EURUSD=X → EURUSD.
 */
function parseTickers(list: string): Ticker[] {
  const tickers: Ticker[] = [];
  for (const part of list.split(",")) {
    const item = part.trim();
    if (item === "" || tickers.length === MAX_TICKERS) continue;
    const cut = item.lastIndexOf("=");
    const labelled = cut > 0 && item.length - cut > 2;
    const symbol = labelled ? item.slice(0, cut).trim() : item;
    tickers.push({ symbol, label: labelled ? item.slice(cut + 1).trim() : symbol.replace(/^\^/, "").split(/[-=.]/)[0] });
  }
  return tickers;
}

/** One ticker's quote and day line from the chart API; null when Yahoo does not know the symbol (404). */
async function load(symbol: string): Promise<Day | null> {
  const url = CHART_URL + encodeURIComponent(symbol) + CHART_QUERY;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const result = ((await res.json()) as ChartAnswer).chart.result[0];
  const meta = result.meta;
  const session = meta.tradingPeriods ? meta.tradingPeriods[0][0] : meta.currentTradingPeriod.regular;
  return {
    quote: {
      price: meta.regularMarketPrice,
      change: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
      decimals: meta.priceHint,
    },
    line: dayLine(result.timestamp ?? [], result.indicators.quote[0].close ?? [], session),
  };
}

/**
 * The day's closes as the chart's line: each close in the column of its time within the session, the later one where
 * two fall in one column, the columns between two closes joined straight; the day's low on the chart's bottom row and
 * its high on the top one. The columns after the last close, the rest of the session, are not in it.
 */
function dayLine(times: number[], closes: (number | null)[], session: { start: number; end: number }): number[] {
  const at: (number | undefined)[] = [];
  for (let i = 0; i < times.length; i++) {
    const close = closes[i];
    if (typeof close !== "number") continue;
    const x = Math.round(((times[i] - session.start) / (session.end - session.start)) * (COLUMNS - 1));
    at[Math.min(COLUMNS - 1, Math.max(0, x))] = close;
  }
  let low = Infinity;
  let high = -Infinity;
  for (const close of at) {
    if (close === undefined) continue;
    low = Math.min(low, close);
    high = Math.max(high, close);
  }
  const row = (close: number) => (high > low ? Math.round(((high - close) / (high - low)) * (CHART_H - 1)) : CHART_H >> 1);
  const rows: number[] = [];
  let last = -1;
  for (let x = 0; x < at.length; x++) {
    const close = at[x];
    if (close === undefined) {
      rows.push(-1);
      continue;
    }
    const from = last < 0 ? close : (at[last] as number);
    for (let g = last + 1; last >= 0 && g < x; g++) rows[g] = row(from + ((close - from) * (g - last)) / (x - last));
    rows.push(row(close));
    last = x;
  }
  return rows;
}

/**
 * Advances of the small font for " " to "~", a base-36 digit each, as busy-lib's glyph map has them: its textWidth()
 * would bundle the maps of every font the app names into the heap.
 */
const SMALL_ADVANCES = "22464552334423234344444444234444555555555245465555554546444333444444443442342644443434464444245";

/** The width of text in the small font; a character the table lacks counts as 4 px. */
function smallWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const advance = SMALL_ADVANCES[ch.charCodeAt(0) - 32];
    width += advance === undefined ? 4 : parseInt(advance, 36);
  }
  return width;
}

/** The width of a large price in the extra_large font, as busy-lib measures it: a digit 8 px, a 1 5 px, "," and "." 3 px, "-" 4 px, "M" 9 px, "E" 7 px. */
function bigWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch === "1" ? 5 : ch === "," || ch === "." ? 3 : ch === "-" ? 4 : ch === "M" ? 9 : ch === "E" ? 7 : 8;
  return width;
}

/** The label cut at its end to fit `room` px in the small font, so that a long one stops short of the price. */
function fit(label: string, room: number): string {
  let out = label;
  while (out.length > 0 && smallWidth(out) > room) out = out.slice(0, -1);
  return out;
}

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

/**
 * The price for the large digits: from 1,000,000 in millions, 1.23M; from 1,000 whole with thousands separators, and
 * from 100,000 without them, since "123,456" would run into the name and the change on the left; from 1 with Yahoo's
 * decimals, but at most four digits, since "356.27" touches the change: 356.3, 45.67, 1.103; under 1 two or three
 * significant digits, 0.356, 0.0066, and under 0.001 as 3.9E-6. The full price is in the chart and on the back.
 */
function bigPrice(quote: Quote): string {
  const price = quote.price;
  // Chosen by the rounded value: 999,999.6 would otherwise come out as "1000000", 9,996,000 as "10.00M".
  const millions = price / 1e6;
  if (Math.round(price) >= 1e6) return `${millions.toFixed(millions >= 99.95 ? 0 : millions >= 9.995 ? 1 : 2)}M`;
  const whole = Math.round(price);
  if (whole >= 100000) return String(whole);
  if (whole >= 1000) return thousands(price);
  if (price >= 1) return price.toFixed(Math.min(quote.decimals, 4 - String(Math.floor(price)).length));
  if (price < 0.001) return price.toExponential(1).toUpperCase();
  return price.toFixed(Math.min(4, 2 - Math.floor(Math.log10(price))));
}

/** The price in full for small text, with Yahoo's decimals and thousands separators: 7,561.67, 1.1028. */
function fullPrice(quote: Quote): string {
  // Under 1 at least three significant digits: Yahoo gives SHIB-USD, 0.0000039, five decimals, which would be 0.00000.
  const price = quote.price;
  const decimals = price > 0 && price < 1 ? Math.min(10, Math.max(quote.decimals, 2 - Math.floor(Math.log10(price)))) : quote.decimals;
  const fixed = price.toFixed(decimals);
  const dot = fixed.indexOf(".");
  return dot < 0 ? thousands(Number(fixed)) : thousands(Number(fixed.slice(0, dot))) + fixed.slice(dot);
}

/** The change with its sign and `decimals` decimals; from 10 % whole percents, since "+12.4%" would touch a six-digit price. */
function changeText(quote: Quote, decimals: number): string {
  const shown = Math.abs(Number(quote.change.toFixed(decimals))) >= 10 ? 0 : decimals;
  return `${quote.change < 0 ? "" : "+"}${quote.change.toFixed(shown)}%`;
}

/** A colour, "#RRGGBBAA", at k of its brightness. */
function shade(color: string, k: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) out += Math.round(parseInt(color.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0");
  return out + color.slice(7);
}

/** The colour of a quote, green on a rise and red on a fall, white without one; dimmed unless the last request brought it, or brought news of an unknown symbol. */
function quoteColor(quote: Quote | null, freshness: Freshness): string {
  const color = quote === null ? WHITE : quote.change < 0 ? RED : GREEN;
  return freshness === "live" || freshness === "unknown" ? color : shade(color, DIM);
}

/** What stands for a price without a quote: "?" for a symbol Yahoo does not know, "--" otherwise. */
function noPrice(freshness: Freshness): string {
  return freshness === "unknown" ? "?" : "--";
}

/** The no-connection picture with its top left corner at x, y. */
function offline(x: number, y: number): Element {
  return { type: "xpmbitmap", id: "offline", data: OFFLINE, x, y, align: "top_left" };
}

/** A triangle 5 pixels wide pointing up or down, as XPM2 rows; the fonts have no ▲▼. */
const ARROW_UP = ["..x..", ".xxx.", "xxxxx"];

/**
 * The price large, right-aligned; on the left small the name, and under it the change after an arrow up or down. The
 * price and the change are green on a rise and red on a fall; "--" without a quote. A quote the last request did not
 * bring is dimmed, and after a failed request the no-connection picture takes the arrow's place.
 */
function quoteFrame(ticker: Ticker, quote: Quote | null, freshness: Freshness): Element[] {
  const color = quoteColor(quote, freshness);
  const lost = freshness === "lost";
  const price = quote === null ? noPrice(freshness) : bigPrice(quote);
  // A six-character price, "64,606", leaves room for one decimal of the change: "+0.76%" would touch it.
  const change = quote === null ? "--" : changeText(quote, price.length < 6 ? 2 : 1);
  const elements: Element[] = [
    { type: "text", id: "price", text: price, font: "extra_large", color, x: 72, y: 8, align: "mid_right" },
    { type: "text", id: "name", text: fit(ticker.label, 72 - bigWidth(price) - 2), font: "small", color: quoteColor(null, freshness), x: 0, y: 4, align: "mid_left" },
    { type: "text", id: "change", text: change, font: "small", color, x: quote === null && !lost ? 0 : 6, y: 12, align: "mid_left" },
  ];
  if (lost) {
    elements.push(offline(0, 10));
  } else if (quote !== null) {
    const rows = quote.change < 0 ? ARROW_UP.slice().reverse() : ARROW_UP;
    const data = ["! XPM2", "5 3 2 1", ". c none", `x c ${color.slice(0, 7)}`, ...rows].join("\n");
    elements.push({ type: "xpmbitmap", id: "arrow", data, x: 0, y: 11, align: "top_left" });
  }
  return elements;
}

/**
 * The day's line over the 72 columns as XPM2, in the colour of the quote, the area under it in a darker shade. In
 * each column the line runs from its row up or down to next to the row of the column before, so that a steep move
 * stays one stroke.
 */
function chartXpm(line: number[], color: string): string {
  const rows = ["! XPM2", `${COLUMNS} ${CHART_H} 3 1`, ". c none", `l c ${color.slice(0, 7)}`, `f c ${shade(color, FILL).slice(0, 7)}`];
  for (let r = 0; r < CHART_H; r++) {
    let out = "";
    for (let x = 0; x < COLUMNS; x++) {
      const y = x < line.length ? line[x] : -1;
      const before = x > 0 && line[x - 1] >= 0 ? line[x - 1] : y;
      const top = before < y ? before + 1 : y;
      const bottom = before > y ? before - 1 : y;
      out += y < 0 || r < top ? "." : r <= bottom ? "l" : "f";
    }
    rows.push(out);
  }
  return rows.join("\n");
}

/**
 * The day's chart of the ticker on the whole width of the display, green on a rise and red on a fall, under a top line
 * with its name and its price small. Dimmed as the quote is, and after a failed request the no-connection picture
 * comes before the name.
 */
function chartFrame(ticker: Ticker, quote: Quote | null, line: number[] | null, freshness: Freshness): Element[] {
  const color = quoteColor(quote, freshness);
  const lost = freshness === "lost";
  const price = quote === null ? noPrice(freshness) : fullPrice(quote);
  const name = fit(ticker.label, 72 - smallWidth(price) - (lost ? 6 : 0) - 3);
  const elements: Element[] = [
    { type: "text", id: "name", text: name, font: "small", color: quoteColor(null, freshness), x: lost ? 6 : 0, y: 3, align: "mid_left" },
    { type: "text", id: "price", text: price, font: "small", color, x: 72, y: 3, align: "mid_right" },
  ];
  if (line !== null && line.length > 0) {
    elements.push({ type: "xpmbitmap", id: "chart", data: chartXpm(line, color), x: 0, y: CHART_TOP, align: "top_left" });
  }
  if (lost) elements.push(offline(0, 1));
  return elements;
}

/**
 * The back display: a row per ticker with its name, its price in full and its change, in white, since its grays turn
 * green and red into two dim shades; dimmed as on the front.
 */
function backFrame(tickers: Ticker[], quotes: (Quote | null)[], freshness: Freshness[]): Element[] {
  const elements: Element[] = [];
  tickers.forEach((ticker, i) => {
    const quote = quotes[i];
    const white = quoteColor(null, freshness[i]);
    const y = BACK_TOP + i * BACK_ROW;
    const price = quote === null ? noPrice(freshness[i]) : fullPrice(quote);
    elements.push(
      { type: "text", id: `bname${i}`, text: fit(ticker.label, BACK_PRICE - smallWidth(price) - 4), font: "small", color: white, x: 0, y, align: "top_left", display: "back" },
      {
        type: "text",
        id: `bprice${i}`,
        text: price,
        font: "small",
        color: white,
        x: BACK_PRICE,
        y,
        align: "top_right",
        display: "back",
      },
      {
        type: "text",
        id: `bchange${i}`,
        text: quote === null ? "--" : changeText(quote, 2),
        font: "small",
        color: white,
        x: BACK_RIGHT,
        y,
        align: "top_right",
        display: "back",
      },
    );
  });
  return elements;
}

/** The last good quotes kept in localStorage, by symbol, and the JSON they were read from; empty without any. */
function kept(): { quotes: Record<string, Quote>; json: string | null } {
  try {
    const json = localStorage.getItem(KEPT_KEY);
    return { quotes: json ? (JSON.parse(json) as Record<string, Quote>) : {}, json };
  } catch {
    return { quotes: {}, json: null };
  }
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  /** Read once, at the start; until then the app draws nothing and takes no input but Back. */
  let tickers: Ticker[] = [];
  let quotes: (Quote | null)[] = [];
  let lines: (number[] | null)[] = [];
  let freshness: Freshness[] = [];
  /** What localStorage holds under KEPT_KEY, so that only a change is written. */
  let saved: string | null = null;
  let shown = 0;
  /** The front shows the day chart of the shown ticker instead of its quote. */
  let charting = false;
  let loading = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let swapTimer: ReturnType<typeof setInterval> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (err: unknown) =>
    console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const screen = createScreen(APP, report);
  const redraw = () => {
    if (stopped || tickers.length === 0) return;
    const front = charting
      ? chartFrame(tickers[shown], quotes[shown], lines[shown], freshness[shown])
      : quoteFrame(tickers[shown], quotes[shown], freshness[shown]);
    screen.show(front.concat(backFrame(tickers, quotes, freshness)));
  };

  /** The quotes take turns, the next one every SWAP_MS; a single ticker has nothing to turn to. */
  function rotate(): void {
    holdTimer = undefined;
    if (tickers.length < 2) return;
    swapTimer = setInterval(() => {
      shown = (shown + 1) % tickers.length;
      redraw();
    }, SWAP_MS);
  }

  /**
   * Holds the shown ticker: the turns stop, and on the quote start again HOLD_MS after the last turn of the wheel or
   * press of OK; the chart stays until OK. Only a pending timer is cleared: clearing one that was never set makes the
   * firmware warn.
   */
  function hold(): void {
    if (swapTimer !== undefined) clearInterval(swapTimer);
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    swapTimer = undefined;
    holdTimer = charting ? undefined : setTimeout(rotate, HOLD_MS);
  }

  /** Writes the quotes to localStorage when they differ from what it holds: every write rewrites the store in flash. */
  function keep(): void {
    const good: Record<string, Quote> = {};
    tickers.forEach((ticker, i) => {
      const quote = quotes[i];
      if (quote !== null) good[ticker.symbol] = quote;
    });
    const json = JSON.stringify(good);
    if (json === saved) return;
    try {
      localStorage.setItem(KEPT_KEY, json);
      saved = json;
    } catch (err) {
      report(err);
    }
  }

  // One round of requests at a time, one ticker after the other. A good answer replaces the ticker's quote and line; a
  // failed one leaves the last good ones on the display, dimmed. The round ends by keeping the quotes in localStorage.
  async function poll(): Promise<void> {
    if (loading) return;
    loading = true;
    for (let i = 0; i < tickers.length; i++) {
      // A request in flight keeps the app alive: after Back the next one is not started.
      if (stopped) break;
      try {
        const day = await load(tickers[i].symbol);
        quotes[i] = day ? day.quote : null;
        lines[i] = day ? day.line : null;
        freshness[i] = day ? "live" : "unknown";
      } catch (err) {
        freshness[i] = "lost";
        report(err);
      }
      redraw();
    }
    loading = false;
    keep();
  }

  /** Starts with the settings: the tickers with the quotes kept from an earlier run, the polls and the turns. */
  function start(values: SettingsValues): void {
    if (stopped) return;
    const list = typeof values.tickers === "string" ? parseTickers(values.tickers) : [];
    tickers = list.length > 0 ? list : parseTickers(DEFAULT_TICKERS);
    const minutes = typeof values.poll_min === "number" ? values.poll_min : DEFAULT_POLL_MIN;
    const stored = kept();
    saved = stored.json;
    quotes = tickers.map((ticker) => stored.quotes[ticker.symbol] ?? null);
    lines = tickers.map(() => null);
    freshness = tickers.map(() => "waiting");
    redraw();
    void poll().catch(report);
    pollTimer = setInterval(() => void poll().catch(report), minutes * 60 * 1000);
    rotate();
  }

  // The wheel picks a ticker and holds it, OK turns its day chart on and off, Back leaves the app. Once the timers are
  // cleared and the handler detached, nothing keeps it alive and the device takes the screen back.
  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      if (tickers.length === 0) return;
      shown = (shown + event.delta + tickers.length) % tickers.length;
      hold();
      redraw();
    } else if (event.action !== "short") {
      return;
    } else if (event.key === "ok") {
      if (tickers.length === 0) return;
      charting = !charting;
      hold();
      redraw();
    } else if (event.key === "back") {
      stopped = true;
      screen.close();
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (swapTimer !== undefined) clearInterval(swapTimer);
      if (holdTimer !== undefined) clearTimeout(holdTimer);

      // Not detached from inside the handler itself: with nothing else left the unbind stops the app on the spot, while this handler is still running.
      setTimeout(unbind, 0);
    }
  });

  void loadValues()
    .then((values) => start(values ?? {}))
    .catch(report);
}

main();
