"use strict";
const childProcess = require("child_process");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
    proc.on("error", reject);
  });
}

module.exports = { run };
