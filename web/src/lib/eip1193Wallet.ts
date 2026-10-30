// Signs Hyperliquid's EIP-712 messages with an injected wallet (Phantom, MetaMask, Rabby…).
//
// viem's WalletClient can't be used here: it validates struct names and rejects Hyperliquid's
// "HyperliquidTransaction:ApproveAgent"-style types before the wallet ever sees them. Wallets
// themselves accept these names (Hyperliquid's own app relies on it), so this talks to the
// provider directly with eth_signTypedData_v4.

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

interface TypedDataParams {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** Shape the Hyperliquid SDK accepts as a JSON-RPC account. */
export function eip1193Wallet(provider: Eip1193, address: `0x${string}`) {
  return {
    async signTypedData(params: TypedDataParams): Promise<`0x${string}`> {
      const data = {
        domain: params.domain,
        types: { EIP712Domain: DOMAIN_TYPE, ...params.types },
        primaryType: params.primaryType,
        message: params.message,
      };
      const json = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      const sig = await provider.request({ method: "eth_signTypedData_v4", params: [address, json] });
      if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("Wallet returned an invalid signature");
      return sig as `0x${string}`;
    },
    async getAddresses(): Promise<`0x${string}`[]> {
      return [address];
    },
    async getChainId(): Promise<number> {
      return Number(await provider.request({ method: "eth_chainId" }));
    },
  };
}
