"use strict";
// ------------------------------------------------------------
// run_fingerprint_eval.js
// ------------------------------------------------------------
// Produces the numbers for Table 3 (Chapter 4): single-pass accuracy,
// TPR, FPR, and mean latency for the fingerprinting engine, per
// degradation condition, at both the unit level (each of the 1,000
// clips tested in isolation) and the stream level (sliding-window
// detection over the full concatenated broadcast).
//
// Run from the same directory as generate-fingerprints.js, since it
// reuses ./lib (Codegen) via match_engine.js.
//
//   node run_fingerprint_eval.js
//
// PERFORMANCE NOTE: the stream-level test spawns one ffmpeg process per
// 10s window per condition per run. With 1,000 tracks x 28s clips you get
// ~7.8 hours of broadcast audio -> roughly 5,600 windows x 5 conditions x
// 2 runs = ~56,000 ffmpeg/Codegen calls. Set UNIT_TEST_SUBSET below to a
// small number (e.g. 50) first to confirm the pipeline and time one
// condition, then decide whether to scale to the full 1,000.
// ------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const os = require("os");

const { buildIndex, matchAudio } = require("./match_engine");
const { degrade, CONDITIONS } = require("./degrade_audio");
const { buildSimulatedBroadcast } = require("./build_broadcast");
const { run } = require("./proc_utils");

const METADATA_FILE = path.resolve(
  "../fma_data_preparation/data/dataset1000/metadata1000.json",
);
const FINGERPRINTS_DIR = path.resolve(
  "../fma_data_preparation/data/dataset1000/fingerprints",
);
const EVAL_DIR = path.resolve("./data/eval_output");

const SAMPLE_RATE = 22050; // matches generate-fingerprints.js
const CHANNELS = 1;

const WINDOW_SECONDS = 10; // Section 3.7.1 capture-logic threshold
const HOP_SECONDS = 5;
const N_RUNS = 2; // Section 3.6.6 reliability protocol

// Set to a number (e.g. 50) to test the pipeline quickly before running
// against the full dataset. Set to null to use everything.
const UNIT_TEST_SUBSET = null;

// Fraction of the broadcast that should be UNREGISTERED "foreign" tracks
// -- i.e. present in the simulated broadcast but deliberately excluded
// from the fingerprint index. Without these, fp/tn stay at 0 and FPR is
// undefined (see fingerprint_results output). These tracks must exist in
// FINGERPRINTS_DIR's source metadata but NOT have been indexed -- easiest
// approach: split metadata1000.json into registered/held-out before
// running generate-fingerprints.js, or point UNREGISTERED_METADATA_FILE
// at a separate small FMA sample that was never fingerprinted.
const UNREGISTERED_METADATA_FILE = null; // e.g. path.resolve("./unregistered_sample.json")
const UNREGISTERED_FRACTION = 0.15; // ~15% of the broadcast should be foreign tracks

// ------------------------------------------------------------
// Stats helpers
// ------------------------------------------------------------
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

// ------------------------------------------------------------
// Unit-level: each track fingerprinted/registered already (via your
// generate-fingerprints.js); here we degrade the ORIGINAL file and check
// whether the engine still recognizes it as itself.
// ------------------------------------------------------------
async function runUnitLevelTests(metadata, index) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-eval-"));
  const results = [];

  for (let i = 0; i < metadata.length; i++) {
    const track = metadata[i];
    const trackId = String(track.custom_track_id);

    for (const condition of CONDITIONS) {
      const degradedPath = path.join(tmpDir, `${trackId}_${condition}.wav`);
      await degrade(path.resolve(track.file), degradedPath, condition);

      const t0 = Date.now();
      const { trackId: matchedId } = await matchAudio(degradedPath, index, {
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      });
      const latencyMs = Date.now() - t0;

      results.push({
        trackId,
        condition,
        correct: matchedId === trackId,
        latencyMs,
      });
      fs.unlinkSync(degradedPath);
    }

    if ((i + 1) % 50 === 0)
      console.log(`  unit tests: ${i + 1}/${metadata.length} tracks`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return results;
}

// ------------------------------------------------------------
// Stream-level: slide a window across the (degraded) broadcast and check
// each window's detection against the ground-truth playlist.
// ------------------------------------------------------------
function groundTruthAt(groundTruth, tStart, tEnd) {
  const mid = (tStart + tEnd) / 2;
  return (
    groundTruth.find((ev) => ev.startSec <= mid && mid <= ev.endSec) || null
  );
}

// A window scores as:
//   tp  -> registered track, correctly identified
//   fn  -> registered track, missed or misidentified
//   fp  -> unregistered track, but the engine matched it to SOMETHING anyway
//   tn  -> unregistered track, correctly left unmatched
//   (windows landing in a gap / no ground truth are skipped -- treated as tn only
//    if the engine also found nothing, otherwise dropped as ambiguous)
function scoreWindow(truth, matchedId) {
  if (truth && truth.registered) {
    return matchedId === truth.trackId ? "tp" : "fn";
  }
  if (truth && !truth.registered) {
    return matchedId ? "fp" : "tn";
  }
  return matchedId ? null : "tn"; // no ground truth event at all (silence/gap)
}

async function runStreamLevelTest(
  broadcastCleanPath,
  groundTruth,
  index,
  condition,
  runDir,
) {
  const degradedPath = path.join(runDir, `broadcast_${condition}.wav`);
  await degrade(broadcastCleanPath, degradedPath, condition);

  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    degradedPath,
  ]);
  const totalDuration = parseFloat(stdout.trim());

  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  const latencies = [];
  const chunkPath = path.join(runDir, `_chunk_${condition}.wav`);

  for (let t = 0; t + WINDOW_SECONDS <= totalDuration; t += HOP_SECONDS) {
    await run("ffmpeg", [
      "-y",
      "-ss",
      String(t),
      "-t",
      String(WINDOW_SECONDS),
      "-i",
      degradedPath,
      chunkPath,
    ]);

    const truth = groundTruthAt(groundTruth, t, t + WINDOW_SECONDS);
    const t0 = Date.now();
    const { trackId: matchedId } = await matchAudio(chunkPath, index, {
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
    latencies.push(Date.now() - t0);

    const verdict = scoreWindow(truth, matchedId);
    if (verdict === "tp") tp++;
    else if (verdict === "fn") fn++;
    else if (verdict === "fp") fp++;
    else if (verdict === "tn") tn++;
    // verdict === null: ambiguous (no ground truth, but something matched) -- skipped
  }

  if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);

  const total = tp + fp + tn + fn;
  return {
    condition,
    accuracy: total ? (tp + tn) / total : null,
    tpr: tp + fn ? tp / (tp + fn) : null,
    fpr: fp + tn ? fp / (fp + tn) : null,
    mean_latency_s: latencies.length ? mean(latencies) / 1000 : null,
    counts: { tp, fp, tn, fn },
  };
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  fs.mkdirSync(EVAL_DIR, { recursive: true });

  let allMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
  if (UNIT_TEST_SUBSET) allMetadata = allMetadata.slice(0, UNIT_TEST_SUBSET);
  console.log(`Loaded ${allMetadata.length} tracks`);

  // Split into registered (indexed, used for TP/FN) and unregistered
  // (held OUT of the index, used as genuine FPR probes). Deterministic
  // split (not random) so results are reproducible run-to-run.
  const heldOutCount = Math.round(allMetadata.length * UNREGISTERED_FRACTION);
  const unregisteredMetadata = allMetadata
    .slice(-heldOutCount)
    .map((t) => ({ ...t, registered: false }));
  const registeredMetadata = allMetadata
    .slice(0, allMetadata.length - heldOutCount)
    .map((t) => ({ ...t, registered: true }));

  console.log(
    `Split: ${registeredMetadata.length} registered, ` +
      `${unregisteredMetadata.length} unregistered (FPR probes)`,
  );

  const excludeTrackIds = new Set(
    unregisteredMetadata.map((t) => String(t.custom_track_id)),
  );

  console.log("Building fingerprint index from", FINGERPRINTS_DIR);
  const index = buildIndex(FINGERPRINTS_DIR, excludeTrackIds);

  console.log(
    "Running unit-level tests (registered tracks only -- these test recall, not FPR)...",
  );
  const unitResults = await runUnitLevelTests(registeredMetadata, index);
  fs.writeFileSync(
    path.join(EVAL_DIR, "fingerprint_unit_results.json"),
    JSON.stringify(unitResults, null, 2),
  );

  console.log(
    "Building simulated broadcast (registered + unregistered tracks, shuffled)...",
  );
  const broadcastMetadata = [...registeredMetadata, ...unregisteredMetadata];
  // Simple deterministic shuffle so registered/unregistered tracks are
  // interleaved rather than all foreign tracks landing at the end.
  for (let i = broadcastMetadata.length - 1; i > 0; i--) {
    const j = (i * 2654435761) % (i + 1); // deterministic pseudo-shuffle
    [broadcastMetadata[i], broadcastMetadata[j]] = [
      broadcastMetadata[j],
      broadcastMetadata[i],
    ];
  }

  const { broadcastPath, groundTruth } = await buildSimulatedBroadcast(
    broadcastMetadata,
    path.join(EVAL_DIR, "broadcast"),
    SAMPLE_RATE,
    CHANNELS,
  );

  console.log(
    "Running stream-level tests across conditions x reliability runs...",
  );
  const streamRuns = [];
  for (let runIdx = 1; runIdx <= N_RUNS; runIdx++) {
    const runDir = path.join(EVAL_DIR, `run_${runIdx}`);
    fs.mkdirSync(runDir, { recursive: true });

    for (const condition of CONDITIONS) {
      const result = await runStreamLevelTest(
        broadcastPath,
        groundTruth,
        index,
        condition,
        runDir,
      );
      result.run = runIdx;
      streamRuns.push(result);
      console.log(`  run ${runIdx} [${condition}]`, result);
    }
  }

  // Aggregate mean/std per condition -- these are the values that go
  // straight into Table 3's Accuracy / TPR / FPR / Mean Latency columns.
  const summary = CONDITIONS.map((condition) => {
    const rows = streamRuns.filter((r) => r.condition === condition);
    const field = (name) => rows.map((r) => r[name]).filter((v) => v != null);
    const agg = (name) => {
      const vals = field(name);
      return vals.length
        ? { mean: mean(vals), std: stdev(vals) }
        : { mean: null, std: null };
    };
    const latencyAgg = agg("mean_latency_s");
    return {
      condition,
      accuracy: agg("accuracy"),
      tpr: agg("tpr"),
      fpr: agg("fpr"),
      mean_latency_ms: {
        mean: latencyAgg.mean != null ? latencyAgg.mean * 1000 : null,
        std: latencyAgg.std != null ? latencyAgg.std * 1000 : null,
      },
    };
  });

  fs.writeFileSync(
    path.join(EVAL_DIR, "fingerprint_results_raw.json"),
    JSON.stringify(streamRuns, null, 2),
  );
  fs.writeFileSync(
    path.join(EVAL_DIR, "fingerprint_results_summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log(
    "\nDone. Table 3 values are in eval_output/fingerprint_results_summary.json",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
