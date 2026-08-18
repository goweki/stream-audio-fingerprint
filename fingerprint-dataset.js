const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const { Codegen } = require("./lib");

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const METADATA_FILE = path.resolve(
  "../fma_data_preparation/data/dataset1000/metadata1000.json",
);
const OUTPUT_DIR = path.resolve(
  "../fma_data_preparation/data/dataset1000/fingerprints",
);

const SAMPLE_RATE = 22050;
const CHANNELS = 1;

const ALGORITHM = "landmark";
const ALGORITHM_VERSION = "1.0.4";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });

    stream.on("error", reject);
  });
}

function getAudioMetadata(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = childProcess.spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,bit_rate",
        "-show_entries",
        "stream=sample_rate,channels",
        "-of",
        "json",
        filePath,
      ],
      {
        stdio: ["ignore", "pipe", process.stderr],
      },
    );

    let output = "";

    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("error", reject);

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}`));
      }

      try {
        const result = JSON.parse(output);

        const format = result.format || {};
        const stream = (result.streams || [])[0] || {};

        resolve({
          duration: format.duration ? Number(format.duration) : null,

          sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,

          bitRate: format.bit_rate ? Number(format.bit_rate) : null,

          channels: stream.channels ? Number(stream.channels) : null,

          fileSize: format.size ? Number(format.size) : null,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function generateFingerprint(filePath) {
  return new Promise((resolve, reject) => {
    const decoder = childProcess.spawn(
      "ffmpeg",
      [
        "-i",
        filePath,

        "-acodec",
        "pcm_s16le",

        "-ar",
        String(SAMPLE_RATE),

        "-ac",
        String(CHANNELS),

        "-f",
        "wav",

        "-v",
        "fatal",

        "pipe:1",
      ],
      {
        stdio: ["ignore", "pipe", process.stderr],
      },
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

    fingerprinter.on("end", () => {
      resolve(hashes);
    });

    fingerprinter.on("error", reject);

    decoder.on("error", reject);

    decoder.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

function outputFilename(track) {
  // Keep filenames safe and deterministic.
  return `${track.custom_track_id}.json`;
}

// ------------------------------------------------------------
// Process one track
// ------------------------------------------------------------

async function processTrack(track, index, total) {
  const filePath = path.resolve(track.file);

  console.log(
    `[${index + 1}/${total}] ${track.custom_track_id} - ${track.title}`,
  );

  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file does not exist: ${filePath}`);
  }

  const outputPath = path.join(OUTPUT_DIR, outputFilename(track));

  // ----------------------------------------------------------
  // Resume support
  // ----------------------------------------------------------

  if (fs.existsSync(outputPath)) {
    console.log(`  ↳ Already processed. Skipping.`);
    return {
      status: "skipped",
      outputPath,
    };
  }

  console.log(`  ↳ Reading audio metadata...`);

  const audioMetadata = await getAudioMetadata(filePath);

  console.log(`  ↳ Calculating SHA-256 checksum...`);

  const checksum = await calculateChecksum(filePath);

  console.log(`  ↳ Generating fingerprints...`);

  const hashes = await generateFingerprint(filePath);

  console.log(`  ↳ Generated ${hashes.length.toLocaleString()} hashes`);

  const result = {
    custom_track_id: String(track.custom_track_id),

    custom_artist_id:
      track.custom_artist_id != null ? String(track.custom_artist_id) : null,

    metadata: {
      title: track.title || path.basename(filePath),
      description: track.description || null,
      artist: track.artist || null,
      album: track.album || null,

      // Kept separately because your metadata file contains
      // a custom artist name that may differ from the original
      // FMA artist field.
      custom_artist_name: track.custom_artist_name || null,

      type: track.type || "MUSIC",
    },

    file: {
      path: filePath,
      filename: path.basename(filePath),
      size: audioMetadata.fileSize,
      checksum,
    },

    audio: {
      duration: audioMetadata.duration,
      sampleRate: audioMetadata.sampleRate,
      bitRate: audioMetadata.bitRate,
      channels: audioMetadata.channels,
    },

    fingerprint: {
      algorithm: ALGORITHM,
      version: ALGORITHM_VERSION,
      generatedAt: new Date().toISOString(),

      hashes,
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");

  console.log(`  ↳ Saved: ${outputPath}`);

  return {
    status: "processed",
    outputPath,
    hashCount: hashes.length,
  };
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
  ensureDirectory(OUTPUT_DIR);

  if (!fs.existsSync(METADATA_FILE)) {
    throw new Error(`Metadata file not found: ${METADATA_FILE}`);
  }

  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));

  if (!Array.isArray(metadata)) {
    throw new Error("metadata1000.json must contain an array.");
  }

  console.log(`Found ${metadata.length.toLocaleString()} tracks.`);

  console.log(`Output directory: ${OUTPUT_DIR}`);

  console.log("");

  const manifest = {
    algorithm: ALGORITHM,
    version: ALGORITHM_VERSION,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,

    generatedAt: new Date().toISOString(),

    total: metadata.length,

    processed: 0,
    skipped: 0,
    failed: 0,

    tracks: [],
  };

  for (let i = 0; i < metadata.length; i++) {
    const track = metadata[i];

    try {
      const result = await processTrack(track, i, metadata.length);

      if (result.status === "processed") {
        manifest.processed++;

        manifest.tracks.push({
          custom_track_id: String(track.custom_track_id),
          custom_artist_id:
            track.custom_artist_id != null
              ? String(track.custom_artist_id)
              : null,
          file: track.file,
          output: result.outputPath,
          hashCount: result.hashCount,
          status: "processed",
        });
      } else {
        manifest.skipped++;

        manifest.tracks.push({
          custom_track_id: String(track.custom_track_id),
          custom_artist_id:
            track.custom_artist_id != null
              ? String(track.custom_artist_id)
              : null,
          file: track.file,
          output: result.outputPath,
          status: "skipped",
        });
      }
    } catch (error) {
      manifest.failed++;

      console.error(`  ✗ Failed: ${error.message}`);

      manifest.tracks.push({
        custom_track_id: String(track.custom_track_id),
        custom_artist_id:
          track.custom_artist_id != null
            ? String(track.custom_artist_id)
            : null,
        file: track.file,
        status: "failed",
        error: error.message,
      });
    }

    // Save the manifest after every file so progress is not
    // lost if the process is interrupted.
    fs.writeFileSync(
      path.join(OUTPUT_DIR, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  console.log("");
  console.log("======================================");
  console.log("Fingerprinting complete");
  console.log("======================================");
  console.log(`Total:     ${manifest.total}`);
  console.log(`Processed: ${manifest.processed}`);
  console.log(`Skipped:   ${manifest.skipped}`);
  console.log(`Failed:    ${manifest.failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
