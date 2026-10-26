import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  nativePtyUsable,
  spawnProcessTerminal,
} from "./ProcessTerminalBackend.js";

// Loads the real native module, so it only means anything where that module can
// run: on a musl host the import is the call that faults.
it.skipIf(!nativePtyUsable())(
  "does not start the command when the capture was cancelled while the native module loaded",
  async () => {
    const marker = path.join(
      os.tmpdir(),
      `rea-capture-cancelled-${String(process.pid)}-${String(Date.now())}`,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled by the test"));
    try {
      await expect(
        spawnProcessTerminal(
          "/bin/sh",
          ["-c", `printf started > ${JSON.stringify(marker)}`],
          {
            cwd: os.tmpdir(),
            env: process.env,
            cols: 80,
            rows: 24,
            name: "xterm-256color",
          },
          { backend: "node-pty", signal: controller.signal },
        ),
      ).rejects.toThrow(/cancelled/u);
      // A command that started would have written the marker before any kill.
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  },
);
