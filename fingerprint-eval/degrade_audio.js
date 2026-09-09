"use strict";
// ------------------------------------------------------------
// degrade_audio.js
// ------------------------------------------------------------
// Produces the five degradation conditions (Section 3.3.1 / 2.2.5(iv))
// using ffmpeg only, matching the rest of your all-ffmpeg toolchain.
// ------------------------------------------------------------

const { run } = require("./proc_utils");

const CONDITIONS = [
  "clean",
  "mp3_64k",
  "mp3_32k",
  "noise_snr20",
  "noise_snr10",
];

async function toClean(inputPath, outputPath) {
  // Re-mux/re-encode to a plain WAV so every condition goes through the
  // same container/codec before matching (fair comparison baseline).
  await run("ffmpeg", ["-y", "-i", inputPath, outputPath]);
}

async function toMp3AndBack(inputPath, outputPath, bitrate) {
  const mp3Path = outputPath.replace(/\.wav$/, ".mp3");
  await run("ffmpeg", ["-y", "-i", inputPath, "-b:a", bitrate, mp3Path]);
  await run("ffmpeg", ["-y", "-i", mp3Path, outputPath]);
}

async function getMeanVolumeDb(inputPath) {
  // ffmpeg's volumedetect filter reports mean_volume on stderr; -f null
  // discards the actual output, so this exits 0 normally.
  const { stderr } = await run("ffmpeg", [
    "-i",
    inputPath,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const match = /mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/.exec(stderr);
  if (!match) throw new Error("Could not parse mean_volume from ffmpeg output");
  return parseFloat(match[1]);
}

async function addNoiseAtSnr(inputPath, outputPath, targetSnrDb) {
  const meanVolumeDb = await getMeanVolumeDb(inputPath);
  const noiseVolumeDb = meanVolumeDb - targetSnrDb;

  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=white:amplitude=1",
    "-filter_complex",
    `[1:a]volume=${noiseVolumeDb}dB[noise];[0:a][noise]amix=inputs=2:duration=first:dropout_transition=0`,
    outputPath,
  ]);
}

async function degrade(inputPath, outputPath, condition) {
  if (condition === "clean") return toClean(inputPath, outputPath);
  if (condition.startsWith("mp3_")) {
    return toMp3AndBack(inputPath, outputPath, condition.split("_")[1]);
  }
  if (condition.startsWith("noise_snr")) {
    return addNoiseAtSnr(
      inputPath,
      outputPath,
      Number(condition.replace("noise_snr", "")),
    );
  }
  throw new Error(`Unknown condition: ${condition}`);
}

module.exports = { degrade, CONDITIONS };
