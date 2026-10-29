import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import { startBackend } from "./backend";

startBackend()
  .then(() => import("../main"))
  .catch((e) => {
    document.getElementById("root")!.textContent = `Demo failed to start: ${e?.message ?? e}`;
    console.error(e);
  });
