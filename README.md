# Stream Audio Fingerprint

> Real-time, streamable audio landmark fingerprinting for Node.js written in TypeScript.

`stream-audio-fingerprint` is a Node.js `Transform` stream module that converts raw PCM audio signals into acoustic fingerprints on the fly. It supports finite audio files as well as infinite live audio streams (e.g., Internet radio, broadcast streams, or microphone feeds).

It serves as one of the core foundational engines of the [Adblock Radio](https://github.com/adblockradio/adblockradio) project.

---

## How It Works

The engine uses the **Landmark Fingerprinting Algorithm** popularized by the Shazam 2003 industrial paper:

1. **Spectrogram Generation:** The stream calculates a Short-Time Fourier Transform (STFT) over incoming audio chunks.
2. **Constellation Peak Picking:** Local amplitude maxima (peaks) are picked across time and frequency. Adaptive time-frequency thresholds keep peak density balanced.
3. **Combinatorial Pairing:** Peaks are paired within a target zone to create dynamic hashes (`hcodes`) tied to precise relative time offsets (`tcodes`).

---

## Features

- **Stream Native:** Uses standard Node.js `Transform` streams for minimal memory footprint.
- **Real-Time Processing:** Low latency peak extraction suitable for live detection.
- **Cross-Platform:** Compatible with Windows, macOS, and Linux when combined with `ffmpeg`.

---

## Getting Started

### Prerequisites

- **Node.js**: 20.x or higher
- **FFmpeg**: Must be installed and available in your system `PATH`.

### Installation

- Download code

```bash
git clone https://github.com/goweki/stream-audio-fingerprint.git
```

- navigate to directory and install dependencies

```
cd stream-audio-fingerprint
npm i
```

---

## Usage Example (`fingerprint-file.js`)

```bash
node fingerprint-file.js ./data/000002.mp3
```

or for a directory of audio files:

```bash
node fingerprint-dataset.js
```

---

## Troubleshooting & Windows Support

### Executing NPM / PowerShell Execution Policies

If running scripts is blocked on Windows PowerShell, set the execution policy for your current session:

```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process

```

### Build Cleanup Errors (`prebuild`)

If `npm run build` fails on Windows due to `rimraf` or `del` path errors, update your `package.json` scripts to use Node's native cross-platform file cleanup:

```json
"scripts": {
  "prepare": "npm run build",
  "prebuild": "node -e \"fs.rmSync('./lib', { recursive: true, force: true })\"",
  "build": "tsc -d"
}

```

---

## Credits & References

- **Shazam Paper:** Avery Li-Chun Wang, ["An Industrial-Strength Audio Search Algorithm"](http://www.ee.columbia.edu/~dpwe/papers/Wang03-shazam.pdf) (2003).
- **MATLAB Reference:** D. Ellis, ["Robust Landmark-Based Audio Fingerprinting"](http://labrosa.ee.columbia.edu/matlab/fingerprint/) (2009).

---

## License

Subject to the terms of the **Mozilla Public License 2.0 (MPL-2.0)**.
