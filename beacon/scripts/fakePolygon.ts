/**
 * Local stand-in for the Polygon REST API.
 *
 * Serves the recorded fixture payloads over real HTTP so the smoke test can
 * exercise the genuine network path — fetch, timeouts, JSON parsing, header
 * auth — in environments without a Polygon key or outbound access.
 *
 * Usage:  npx tsx scripts/fakePolygon.ts [port]
 */
import { createServer } from "node:http";
import {
  NVDA_TICKER_DETAILS,
  NVDA_SNAPSHOT,
  NVDA_AGGS,
  NVDA_FINANCIALS,
  NVDA_NEWS,
} from "../src/testing/fixtures.js";

const port = Number(process.argv[2] ?? 8787);

const server = createServer((req, res) => {
  const url = req.url ?? "";

  // Mirror the real API's auth behaviour so the header path is exercised.
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ERROR", message: "missing credentials" }));
    return;
  }

  let body: unknown;
  if (url.includes("/v3/reference/tickers/")) body = NVDA_TICKER_DETAILS;
  else if (url.includes("/v2/snapshot/")) body = NVDA_SNAPSHOT;
  else if (url.includes("/range/1/day/")) body = NVDA_AGGS;
  else if (url.includes("/vX/reference/financials")) body = NVDA_FINANCIALS;
  else if (url.includes("/v2/reference/news")) body = NVDA_NEWS;
  else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "NOT_FOUND" }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

server.listen(port, () => {
  console.log(`fake-polygon listening on http://127.0.0.1:${port}`);
});
