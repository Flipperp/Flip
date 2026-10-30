"""Checks every request Flip's browser code signs against the official Hyperliquid Python SDK.

    pip install hyperliquid-python-sdk
    node web/scripts/hl-signing-capture.mjs > /tmp/hl.json && python3 scripts/hl_verify_signing.py /tmp/hl.json
"""
import json, copy, sys
from eth_account import Account
from hyperliquid.utils import signing as S

d = json.load(open(sys.argv[1]))
MAIN = Account.from_key("0x0123456789012345678901234567890123456789012345678901234567890123")
seen = {}
orig = S.sign_user_signed_action
def keep_chain(wallet, action, payload_types, primary_type, is_mainnet):
    # Identical to the official function, except it keeps the signatureChainId the wallet used
    # (the official SDK hardcodes 0x66eee; Hyperliquid accepts any).
    chain = action["signatureChainId"]
    seen["types"], seen["primary"] = payload_types, primary_type
    action["hyperliquidChain"] = "Mainnet" if is_mainnet else "Testnet"
    action["signatureChainId"] = chain
    return S.sign_inner(wallet, S.user_signed_payload(primary_type, payload_types, action))
S.sign_user_signed_action = keep_chain
fns = {"approveBuilderFee": S.sign_approve_builder_fee, "approveAgent": S.sign_agent, "withdraw3": S.sign_withdraw_from_bridge_action, "usdClassTransfer": S.sign_usd_class_transfer_action}
AGENT = Account.from_key("0x822e9959e022b78423eb653a62ea0020cd283e71a2a8133a6ff2aeffaf373cff")
ok = True
for c in d["captured"]:
    a = copy.deepcopy(c["body"]["action"]); t = a["type"]
    if t not in fns:
        body = c["body"]
        if t == "order":
            assert json.dumps(S.order_wires_to_order_action(a["orders"], a.get("builder"))) == json.dumps(a)
        mine = S.sign_l1_action(AGENT, a, body.get("vaultAddress"), body["nonce"], body.get("expiresAfter"), True)
        m = all(int(mine[k], 16) == int(body["signature"][k], 16) for k in ("r", "s")) and mine["v"] == body["signature"]["v"]
        ok &= m
        print(f"{t:18} {'MATCH' if m else 'MISMATCH'}")
        continue
    mine = fns[t](MAIN, copy.deepcopy(a), True)
    sig = c["body"]["signature"]
    m = int(mine["r"], 16) == int(sig["r"], 16) and int(mine["s"], 16) == int(sig["s"], 16) and mine["v"] == sig["v"]
    rec = S.recover_user_from_user_signed_action(a, sig, seen["types"], seen["primary"], True)
    good = m and rec.lower() == MAIN.address.lower()
    ok &= good
    print(f"{t:18} {'MATCH' if m else 'MISMATCH'}  recovers main wallet: {rec.lower() == MAIN.address.lower()}")
print("ALL MATCH" if ok else "FAILURES")
sys.exit(0 if ok else 1)
