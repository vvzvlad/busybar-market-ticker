# Market Ticker

Stock and crypto prices in large digits, gains in green and losses in red.

A JavaScript app for [BUSY Bar](https://busy.app). Work in progress.

## What it does

- The front display shows the tickers in turn: the price in large digits, the name and the change with an arrow up or down small on the left, gains in green and losses in red.
- The wheel switches to a single ticker with its chart for the day.
- The back display shows a table of all your tickers.
- Settings: the list of tickers and how often to update.

## Data

Yahoo Finance chart data, [CoinGecko](https://www.coingecko.com/en/api) and [Frankfurter](https://frankfurter.dev) (ECB rates), no keys needed.

## Build

Node 24 and npm:

```sh
npm ci
npm run build         # dist/io.github.vvzvlad.ticker.tgz
npm run app:install   # install it on a BUSY Bar connected over USB
npm run app:run       # start it
```

## License

[MIT](LICENSE)
