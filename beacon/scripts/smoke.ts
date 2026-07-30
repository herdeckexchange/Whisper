/**
 * Live smoke test against the real Polygon API.
 *
 * Usage:  POLYGON_API_KEY=... npx tsx scripts/smoke.ts NVDA
 *
 * This is the check that proves the Definition of Done end to end: a real
 * symbol goes in, real external data comes back, gets normalized, stored, and
 * assembled into a data package with visible provenance.
 *
 * It prints only normalized output and never echoes the API key.
 */
import { createBeaconBrain } from "../src/index.js";

const symbol = process.argv[2] ?? "NVDA";

async function main() {
  const brain = await createBeaconBrain({});
  await brain.start();

  console.log(`\nFetching Beacon data package for ${symbol}…\n`);
  const pkg = await brain.services.dataPackages.build(symbol);

  console.log("=".repeat(72));
  console.log(`${pkg.symbol}  ${pkg.asset?.name ?? "(no profile)"}`);
  console.log(`assetId: ${pkg.assetId}   complete: ${pkg.complete}`);
  console.log("=".repeat(72));

  const s = pkg.marketSnapshot;
  console.log("\n--- Market snapshot ---");
  if (s) {
    for (const [k, v] of [
      ["price", s.price],
      ["previousClose", s.previousClose],
      ["change", s.change],
      ["changePercent", s.changePercent],
      ["open", s.open],
      ["high", s.high],
      ["low", s.low],
      ["volume", s.volume],
      ["averageVolume", s.averageVolume],
      ["52wHigh", s.fiftyTwoWeekHigh],
      ["52wLow", s.fiftyTwoWeekLow],
    ] as const) {
      console.log(`  ${String(k).padEnd(16)} ${v ?? "(not supplied)"}`);
    }
    console.log(`  ${"marketTimestamp".padEnd(16)} ${s.marketTimestamp ?? "(none)"}`);
    console.log(`  ${"freshness".padEnd(16)} ${s.provenance.freshness}`);
  } else {
    console.log("  unavailable");
  }

  console.log("\n--- Asset profile ---");
  console.log(`  exchange   ${pkg.asset?.exchange ?? "-"}`);
  console.log(`  industry   ${pkg.asset?.industry ?? "-"}`);
  console.log(`  sector     ${pkg.asset?.sector ?? "(provider does not supply)"}`);
  console.log(`  marketCap  ${pkg.asset?.marketCap ?? "-"} (${pkg.asset?.capTier})`);

  console.log(`\n--- Historical prices (${pkg.historicalPrices.length} bars) ---`);
  for (const bar of pkg.historicalPrices.slice(-5)) {
    console.log(`  ${bar.date}  close=${bar.close}  volume=${bar.volume}`);
  }

  console.log("\n--- Fundamentals ---");
  if (pkg.fundamentals) {
    console.log(`  period     ${pkg.fundamentals.reportingPeriod}`);
    console.log(`  revenue    ${pkg.fundamentals.revenue}`);
    console.log(`  earnings   ${pkg.fundamentals.earnings}`);
    console.log(`  eps        ${pkg.fundamentals.eps}`);
    console.log(`  margin     ${pkg.fundamentals.profitMargin}`);
  } else {
    console.log("  unavailable");
  }

  console.log(`\n--- News (${pkg.news.length} after de-duplication) ---`);
  for (const n of pkg.news.slice(0, 5)) {
    console.log(`  [${n.publishedAt ?? "?"}] ${n.headline}`);
    console.log(`      publisher=${n.publisher ?? "?"}  group=${n.duplicateGroupId}`);
  }

  console.log("\n--- Section provenance ---");
  for (const [name, sec] of Object.entries(pkg.sections)) {
    console.log(
      `  ${name.padEnd(18)} ok=${String(sec.ok).padEnd(5)} ` +
        `${(sec.providerName ?? "-").padEnd(12)} ${sec.freshness.padEnd(10)} ` +
        `${sec.error ? `ERROR: ${sec.error}` : ""}`,
    );
  }

  console.log("\n--- Warnings ---");
  for (const w of pkg.warnings) console.log(`  [${w.section}/${w.code}] ${w.message}`);
  if (!pkg.warnings.length) console.log("  none");

  console.log("\n--- Sources ---");
  for (const src of pkg.sources) {
    console.log(`  ${src.providerName}  health=${src.healthStatus}  tier=${src.reliabilityTier}`);
    console.log(`      lastSuccess=${src.lastSuccessfulRefresh ?? "-"}`);
    console.log(`      attribution="${src.attribution ?? "-"}"`);
  }

  console.log("\n--- Persistence check ---");
  console.log(`  snapshots stored: ${await brain.store.countSnapshots(pkg.assetId ?? "")}`);
  console.log(`  bars stored:      ${(await brain.store.listHistoricalPrices(pkg.assetId ?? "")).length}`);

  console.log("\n--- Scheduled refresh job ---");
  await brain.scheduler.runNow("refresh-prices");
  const [run] = await brain.store.listJobRuns(1);
  console.log(`  status=${run?.status}  processed=${run?.symbolsProcessed.join(",")}  errors=${run?.errors.length}`);
  console.log(`  snapshots after job: ${await brain.store.countSnapshots(pkg.assetId ?? "")}`);

  brain.stop();
  console.log("\nDone.\n");
}

main().catch((e) => {
  // Env validation failures print their full issue list here.
  console.error("\nSmoke test failed:\n", e instanceof Error ? e.message : e, "\n");
  process.exit(1);
});
