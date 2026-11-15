# Market Ticker

Stock and crypto prices in large digits, gains in green and losses in red.

A JavaScript app for [BUSY Bar](https://busy.app). Work in progress.

## What it does

- The front display shows your tickers in turn every five seconds: the price in large digits, the name and the day's change with an arrow up or down small on the left, gains in green and losses in red.
- The wheel picks a ticker and holds it; after half a minute without a turn they take turns again. OK shows the held ticker's chart for the day and back.
- The back display shows a table of all your tickers: the price and the day's change.
- Settings: up to six Yahoo Finance symbols, such as `^GSPC`, `AAPL`, `BTC-USD` or `EURUSD=X`, each with an optional label (`^GSPC=S&P 500`), and the minutes between updates.
- Without a connection the last prices stay, dimmed, with a red cross.

## Data

Yahoo Finance chart data, no key needed.

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
