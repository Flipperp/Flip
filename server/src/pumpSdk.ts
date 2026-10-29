import { createRequire } from "node:module";

// The pump SDKs' ESM builds import `BN` from @coral-xyz/anchor's ESM entry, which doesn't export it
// under plain Node. Their CommonJS builds work, so load those.
const require = createRequire(import.meta.url);
export const pump: typeof import("@pump-fun/pump-sdk") = require("@pump-fun/pump-sdk");
export const pumpSwap: typeof import("@pump-fun/pump-swap-sdk") = require("@pump-fun/pump-swap-sdk");
