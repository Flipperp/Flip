// Captures the exact /exchange bodies the browser code path produces, for cross-checking with the
// official Python SDK.
import http from "node:http";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { execFileSync } from "node:child_process";
import { eip1193Wallet } from "../src/lib/eip1193Wallet.ts";
import { privateKeyToAccount } from "viem/accounts";

const MAIN_PK = "0x0123456789012345678901234567890123456789012345678901234567890123";
const AGENT_PK = "0x822e9959e022b78423eb653a62ea0020cd283e71a2a8133a6ff2aeffaf373cff";
const BUILDER = "0x1111111111111111111111111111111111111111";
const captured = [];
const srv = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    captured.push({ path: req.url, body: JSON.parse(b) });
    res.setHeader("content-type", "application/json");
    const a = JSON.parse(b).action;
    if (a.type === "order") res.end(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "81", avgPx: "1.2", oid: 1 } }] } } }));
    else res.end(JSON.stringify({ status: "ok", response: { type: "default" } }));
  });
});
await new Promise((r) => srv.listen(0, r));
const apiUrl = `http://127.0.0.1:${srv.address().port}`;
const transport = new HttpTransport({ apiUrl });

// Main wallet through an EIP-1193 provider, exactly like Phantom/MetaMask in the browser.
const mainAcct = privateKeyToAccount(MAIN_PK);
const provider = {
  async request({ method, params }) {
    if (method === "eth_chainId") return "0xa4b1";
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [mainAcct.address];
    if (method === "eth_signTypedData_v4") {
      const [from, json] = params;
      if (from.toLowerCase() !== mainAcct.address.toLowerCase()) throw new Error("wrong from");
      return execFileSync("python3", [new URL("../../scripts/hl_sign_typed_data.py", import.meta.url).pathname, MAIN_PK], { input: json }).toString().trim();
    }
    throw new Error("unsupported " + method);
  },
};
const wallet = eip1193Wallet(provider, mainAcct.address);
const main = new ExchangeClient({ transport, wallet });
await main.approveBuilderFee({ builder: BUILDER, maxFeeRate: "0.05%" });
const agentAcct = privateKeyToAccount(AGENT_PK);
await main.approveAgent({ agentAddress: agentAcct.address, agentName: "Flip" });
await main.withdraw3({ destination: mainAcct.address, amount: "12.5" });
await main.usdClassTransfer({ amount: "3", toPerp: true });

const agent = new ExchangeClient({ transport, wallet: agentAcct });
await agent.updateLeverage({ asset: 5, isCross: false, leverage: 5 });
await agent.order({ orders: [{ a: 5, b: true, p: "1.2715", s: "81", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na", builder: { b: BUILDER, f: 50 } });
await agent.order({ orders: [{ a: 5, b: false, p: "1.1975", s: "81", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na", builder: { b: BUILDER, f: 25 } });
srv.close();
console.log(JSON.stringify({ main: mainAcct.address, agent: agentAcct.address, captured }, null, 1));
