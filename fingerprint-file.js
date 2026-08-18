const childProcess = require("child_process");
const { Codegen } = require("./lib");

// Get file path from command line arg, or default to ./data/000002.mp3
const inputFile = process.argv[2] || "./data/000002.mp3";

const decoder = childProcess.spawn(
  "ffmpeg",
  [
    "-i",
    inputFile, // Read directly from file
    "-acodec",
    "pcm_s16le",
    "-ar",
    "22050",
    "-ac",
    "1",
    "-f",
    "wav",
    "-v",
    "fatal",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", process.stderr] },
);

const fingerprinter = new Codegen();

// Pipe decoder output to fingerprinter
decoder.stdout.pipe(fingerprinter);

// Log output codes
fingerprinter.on("data", (data) => {
  for (let i = 0; i < data.tcodes.length; i++) {
    console.log(`time=${data.tcodes[i]} fingerprint=${data.hcodes[i]}`);
  }
});

fingerprinter.on("end", () => {
  console.log("Fingerprints stream ended.");
});
