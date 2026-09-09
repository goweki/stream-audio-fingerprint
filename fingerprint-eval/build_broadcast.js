"use strict";
// ------------------------------------------------------------
// build_broadcast.js
// ------------------------------------------------------------
// Trims each registered track to CLIP_SECONDS and concatenates the clips
// into one continuous "broadcast" WAV, recording the ground-truth
// playlist (start/end timestamps per track) as described in Section 3.6.4.
// ------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { run } = require("./proc_utils");

const CLIP_SECONDS = 28;

async function trimClip(inputPath, outputPath, sampleRate, channels) {
  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-t",
    String(CLIP_SECONDS),
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    String(channels),
    outputPath,
  ]);
}

async function getDuration(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

async function buildSimulatedBroadcast(
  metadata,
  workDir,
  sampleRate,
  channels,
) {
  fs.mkdirSync(workDir, { recursive: true });
  const clipsDir = path.join(workDir, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });

  const listPath = path.join(workDir, "concat_list.txt");
  const listLines = [];
  const groundTruth = [];
  let cursorSec = 0;

  for (const track of metadata) {
    const trackId = String(track.custom_track_id);
    const clipPath = path.join(clipsDir, `${trackId}.wav`);

    await trimClip(path.resolve(track.file), clipPath, sampleRate, channels);
    const duration = await getDuration(clipPath);

    listLines.push(`file '${clipPath}'`);
    groundTruth.push({
      trackId,
      artistId:
        track.custom_artist_id != null ? String(track.custom_artist_id) : null,
      startSec: cursorSec,
      endSec: cursorSec + duration,
    });
    cursorSec += duration;
  }

  fs.writeFileSync(listPath, listLines.join("\n"), "utf8");

  const broadcastPath = path.join(workDir, "broadcast_clean.wav");
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    broadcastPath,
  ]);

  fs.writeFileSync(
    path.join(workDir, "ground_truth.json"),
    JSON.stringify(groundTruth, null, 2),
  );

  return { broadcastPath, groundTruth };
}

module.exports = { buildSimulatedBroadcast, CLIP_SECONDS };
