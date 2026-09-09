"use strict";
// ------------------------------------------------------------
// match_engine.js
// ------------------------------------------------------------
// Companion to generate-fingerprints.js. That script only produces the
// per-track hash lists; this module (a) loads them into a single
// in-memory lookup index, and (b) matches a query clip against that
// index using offset-histogram voting -- the same alignment logic
// described for the Landmark/Dejavu algorithm in Section 3.3.1.
// ------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { Codegen } = require("../lib");

const FP_MIN_MATCHES = 8; // min aligned-hash votes required to call a match

// ------------------------------------------------------------
// Build the in-memory hash index from the per-track JSON files
// generate-fingerprints.js already wrote to FINGERPRINTS_DIR.
// ------------------------------------------------------------
// excludeTrackIds: optional Set<string> of track IDs to leave OUT of the
// index even though their fingerprint JSON exists on disk. This is how
// you create genuine "unregistered / foreign" probes for FPR testing --
// their audio can still appear in the simulated broadcast, but the
// matcher has never seen their hashes, so any match against them is a
// true false positive rather than an artifact of them being indexed.
function buildIndex(fingerprintsDir, excludeTrackIds = new Set()) {
  const index = new Map(); // hash -> [{ trackId, offsetMs }, ...]
  const files = fs
    .readdirSync(fingerprintsDir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json");

  let includedCount = 0;
  for (const file of files) {
    const record = JSON.parse(
      fs.readFileSync(path.join(fingerprintsDir, file), "utf8"),
    );
    const trackId = record.custom_track_id;
    if (excludeTrackIds.has(trackId)) continue;
    includedCount++;

    for (const { hash, offsetMs } of record.fingerprint.hashes) {
      if (!index.has(hash)) index.set(hash, []);
      index.get(hash).push({ trackId, offsetMs });
    }
  }

  console.log(
    `Index built: ${includedCount} tracks indexed ` +
      `(${excludeTrackIds.size} held out as unregistered), ` +
      `${index.size.toLocaleString()} unique hashes`,
  );
  return index;
}

// ------------------------------------------------------------
// Generate hashes for an arbitrary query file (a degraded track, or a
// sliding-window chunk of the simulated broadcast). Mirrors
// generateFingerprint() from generate-fingerprints.js exactly, so
// query-time fingerprints are produced the same way as registration-time
// fingerprints.
// ------------------------------------------------------------
function fingerprintFile(filePath, sampleRate, channels) {
  return new Promise((resolve, reject) => {
    const decoder = childProcess.spawn(
      "ffmpeg",
      [
        "-i",
        filePath,
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "-f",
        "wav",
        "-v",
        "fatal",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", process.stderr] },
    );

    const fingerprinter = new Codegen();
    const hashes = [];

    decoder.stdout.pipe(fingerprinter);

    fingerprinter.on("data", (data) => {
      for (let i = 0; i < data.tcodes.length; i++) {
        hashes.push({
          hash: Number(data.hcodes[i]),
          offsetMs: Number(data.tcodes[i]),
        });
      }
    });

    fingerprinter.on("end", () => resolve(hashes));
    fingerprinter.on("error", reject);
    decoder.on("error", reject);
    decoder.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

// ------------------------------------------------------------
// Match a query clip against the index. For every query hash that also
// appears in the index, we look at the time-offset difference between
// where it occurred in the reference track and where it occurred in the
// query. A genuine match produces a spike of hashes sharing the SAME
// offset difference; unrelated audio does not.
// ------------------------------------------------------------
async function matchAudio(
  filePath,
  index,
  { sampleRate = 22050, channels = 1 } = {},
) {
  const queryHashes = await fingerprintFile(filePath, sampleRate, channels);
  const votes = new Map(); // trackId -> Map(offsetDiff -> count)

  for (const { hash, offsetMs: qOffset } of queryHashes) {
    const matches = index.get(hash);
    if (!matches) continue;

    for (const { trackId, offsetMs: dbOffset } of matches) {
      const diff = dbOffset - qOffset;
      if (!votes.has(trackId)) votes.set(trackId, new Map());
      const trackVotes = votes.get(trackId);
      trackVotes.set(diff, (trackVotes.get(diff) || 0) + 1);
    }
  }

  let bestTrack = null;
  let bestCount = 0;
  for (const [trackId, offsetCounts] of votes) {
    const top = Math.max(...offsetCounts.values());
    if (top > bestCount) {
      bestCount = top;
      bestTrack = trackId;
    }
  }

  return bestCount >= FP_MIN_MATCHES
    ? { trackId: bestTrack, votes: bestCount }
    : { trackId: null, votes: bestCount };
}

module.exports = { buildIndex, fingerprintFile, matchAudio, FP_MIN_MATCHES };
