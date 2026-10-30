"""
Local stand-in for Hyperliquid's API, for end-to-end tests of the Hyperliquid route.

It checks signatures the way Hyperliquid does, using the official Python SDK's recovery code: user
actions must be signed by the account, orders by an agent that account approved, and builder fees
must sit under the account's approved cap. Fills happen at mid. No network, no real funds.

    pip install hyperliquid-python-sdk
    FLIP_URL=http://localhost:8787 python3 scripts/mock_hyperliquid.py 8790

Then run Flip with HL_API_URL=http://localhost:8790 and an HL_MAP that links demo coins, e.g.
HL_MAP=DemoGoose2222222222222222222222222222222pump:GOOSE:1,DemoBagel5555555555555555555555555555555pump:kBAGEL:1000
"""

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from hyperliquid.utils import signing as S

FLIP_URL = os.environ.get("FLIP_URL", "http://localhost:8787")
SOL_USD = float(os.environ.get("MOCK_SOL_USD", "150"))
MAP = [e.split(":") for e in os.environ.get("HL_MAP", "").split(",") if e]

lock = threading.Lock()
users = {}  # addr -> {"usdc": float, "spot": float, "agents": {addr: name}, "builder": {addr: tenths}, "pos": {coin: {...}}, "lev": {coin: (lev, cross)}}
agent_owner = {}  # agent addr -> user addr
builder_fees = {}  # builder -> usd
log = []

UNIVERSE = [
    {"name": "BTC", "szDecimals": 5, "maxLeverage": 40},
    {"name": "SOL", "szDecimals": 2, "maxLeverage": 20},
]
for mint, coin, *rest in MAP:
    UNIVERSE.append({"name": coin, "szDecimals": 0, "maxLeverage": 5})

_flip_cache = {"t": 0, "m": {}}


def flip_prices():
    if time.time() - _flip_cache["t"] < 1:
        return _flip_cache["m"]
    try:
        with urllib.request.urlopen(f"{FLIP_URL}/api/markets?mode=paper", timeout=3) as r:
            _flip_cache["m"] = {m["mint"]: m["price"] for m in json.load(r)}
            _flip_cache["t"] = time.time()
    except Exception:
        pass
    return _flip_cache["m"]


def mids():
    out = {"BTC": 100000.0, "SOL": SOL_USD}
    fp = flip_prices()
    for mint, coin, *rest in MAP:
        mult = float(rest[0]) if rest else 1.0
        p = fp.get(mint)
        if p:
            out[coin] = p * SOL_USD * mult * 1.002  # a small basis, like a real perp
    return out


def user(a):
    a = a.lower()
    return users.setdefault(a, {"usdc": 0.0, "spot": 0.0, "agents": {}, "builder": {}, "pos": {}, "lev": {}})


def upnl(p, mid):
    return p["szi"] * (mid - p["entryPx"])


def clearinghouse(a):
    u = user(a)
    m = mids()
    aps, used, total_upnl = [], 0.0, 0.0
    for coin, p in u["pos"].items():
        mid = m.get(coin, p["entryPx"])
        pnl = upnl(p, mid)
        total_upnl += pnl
        used += p["margin"]
        lev = p["lev"]
        liq = p["entryPx"] * (1 - (1 / lev - 1 / (2 * 5))) if p["szi"] > 0 else p["entryPx"] * (1 + (1 / lev - 1 / (2 * 5)))
        aps.append({"type": "oneWay", "position": {
            "coin": coin, "szi": repr_sz(p["szi"]), "leverage": {"type": "cross" if p["cross"] else "isolated", "value": lev, **({} if p["cross"] else {"rawUsd": "0"})},
            "entryPx": str(p["entryPx"]), "positionValue": str(abs(p["szi"]) * mid), "unrealizedPnl": str(pnl),
            "returnOnEquity": str(pnl / p["margin"] if p["margin"] else 0), "liquidationPx": str(liq), "marginUsed": str(p["margin"] + pnl),
            "maxLeverage": 5, "cumFunding": {"allTime": "0", "sinceOpen": "0", "sinceChange": "0"}}})
    av = u["usdc"] + used + total_upnl
    summ = {"accountValue": str(av), "totalNtlPos": "0", "totalRawUsd": str(av), "totalMarginUsed": str(used)}
    return {"marginSummary": summ, "crossMarginSummary": summ, "crossMaintenanceMarginUsed": "0", "withdrawable": str(u["usdc"]), "assetPositions": aps, "time": int(time.time() * 1000)}


def repr_sz(x):
    s = f"{x:.6f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


USER_TYPES = {
    "approveAgent": (S.sign_agent, None),
    "approveBuilderFee": (S.sign_approve_builder_fee, None),
    "withdraw3": (S.sign_withdraw_from_bridge_action, None),
    "usdClassTransfer": (S.sign_usd_class_transfer_action, None),
}


def recover_user_signed(action, sig):
    # Pull the official type list for this action out of the SDK's own signer.
    seen = {}

    def grab(wallet, a, types, primary, is_mainnet):
        seen["t"], seen["p"] = types, primary
        raise StopIteration

    orig = S.sign_user_signed_action
    S.sign_user_signed_action = grab
    try:
        USER_TYPES[action["type"]][0](None, dict(action), True)
    except StopIteration:
        pass
    finally:
        S.sign_user_signed_action = orig
    return S.recover_user_from_user_signed_action(action, sig, seen["t"], seen["p"], action.get("hyperliquidChain") == "Mainnet").lower()


def err(msg):
    return {"status": "err", "response": msg}


def exchange(body):
    action, sig, nonce = body["action"], body["signature"], body["nonce"]
    t = action["type"]
    with lock:
        if t in USER_TYPES:
            signer = recover_user_signed(action, sig)
            u = user(signer)
            log.append((t, signer))
            if t == "approveAgent":
                if u["usdc"] + u["spot"] <= 0 and not u["pos"]:
                    return err(f"User or API Wallet {signer} does not exist.")
                name = action.get("agentName") or ""
                for a, n in list(u["agents"].items()):
                    if n == name:
                        del u["agents"][a]
                        agent_owner.pop(a, None)
                ag = action["agentAddress"].lower()
                u["agents"][ag] = name
                agent_owner[ag] = signer
            elif t == "approveBuilderFee":
                u["builder"][action["builder"].lower()] = round(float(action["maxFeeRate"].rstrip("%")) * 1000)
            elif t == "withdraw3":
                amt = float(action["amount"])
                if amt > u["usdc"]:
                    return err("Insufficient balance for withdrawal")
                u["usdc"] -= amt
            elif t == "usdClassTransfer":
                amt = float(action["amount"])
                if amt > u["spot"]:
                    return err("Insufficient balance")
                u["spot"] -= amt
                u["usdc"] += amt
            return {"status": "ok", "response": {"type": "default"}}

        signer = S.recover_agent_or_user_from_l1_action(action, sig, body.get("vaultAddress"), nonce, body.get("expiresAfter"), True).lower()
        owner = agent_owner.get(signer) or (signer if signer in users else None)
        if not owner:
            return err(f"User or API Wallet {signer} does not exist.")
        u = user(owner)
        log.append((t, owner, signer))
        if t == "updateLeverage":
            coin = UNIVERSE[action["asset"]]["name"]
            if coin in u["pos"]:
                return err("Cannot switch leverage type with open position.")
            u["lev"][coin] = (action["leverage"], action["isCross"])
            return {"status": "ok", "response": {"type": "default"}}
        if t == "order":
            b = action.get("builder")
            if b and b["f"] > u["builder"].get(b["b"].lower(), -1):
                return err("Builder fee has not been approved.")
            statuses = []
            m = mids()
            for o in action["orders"]:
                coin = UNIVERSE[o["a"]]["name"]
                mid = m.get(coin)
                px, sz, buy = float(o["p"]), float(o["s"]), o["b"]
                if not mid or (buy and px < mid) or (not buy and px > mid):
                    statuses.append({"error": "Order could not immediately match against any resting orders. asset=%d" % o["a"]})
                    continue
                lev, cross = u["lev"].get(coin, (5, True))
                signed = sz if buy else -sz
                p = u["pos"].get(coin)
                fee = sz * mid * 0.00045 + (sz * mid * b["f"] / 100000 if b else 0)
                if b:
                    builder_fees[b["b"].lower()] = builder_fees.get(b["b"].lower(), 0) + sz * mid * b["f"] / 100000
                if o["r"]:
                    if not p or (p["szi"] > 0) == buy or sz > abs(p["szi"]) + 1e-9:
                        statuses.append({"error": "Reduce only order would increase position."})
                        continue
                    frac = sz / abs(p["szi"])
                    pnl = (mid - p["entryPx"]) * (sz if p["szi"] > 0 else -sz)
                    released = p["margin"] * frac
                    u["usdc"] += released + pnl - fee
                    p["margin"] -= released
                    p["szi"] += signed
                    if abs(p["szi"]) < 1e-9:
                        del u["pos"][coin]
                else:
                    margin = sz * mid / lev
                    if margin + fee > u["usdc"]:
                        statuses.append({"error": "Insufficient margin to place order. asset=%d" % o["a"]})
                        continue
                    u["usdc"] -= margin + fee
                    if p:
                        tot = p["szi"] + signed
                        p["entryPx"] = (p["entryPx"] * abs(p["szi"]) + mid * sz) / abs(tot)
                        p["szi"] = tot
                        p["margin"] += margin
                    else:
                        u["pos"][coin] = {"szi": signed, "entryPx": mid, "margin": margin, "lev": lev, "cross": cross}
                statuses.append({"filled": {"totalSz": o["s"], "avgPx": str(mid), "oid": int(time.time() * 1000)}})
            return {"status": "ok", "response": {"type": "order", "data": {"statuses": statuses}}}
        return err(f"mock does not implement {t}")


def info(body):
    t = body["type"]
    m = mids()
    if t in ("meta", "metaAndAssetCtxs"):
        meta = {"universe": UNIVERSE, "marginTables": [], "collateralToken": 0}
        if t == "meta":
            return meta
        ctxs = [{"markPx": str(m.get(u["name"], 0)), "midPx": str(m.get(u["name"], 0)), "oraclePx": str(m.get(u["name"], 0)), "funding": "0.0000125",
                 "openInterest": "123456", "dayNtlVlm": "9876543", "prevDayPx": str(m.get(u["name"], 0)), "premium": "0", "impactPxs": None, "dayBaseVlm": "0"} for u in UNIVERSE]
        return [meta, ctxs]
    if t == "allMids":
        return {k: str(v) for k, v in m.items()}
    if t == "clearinghouseState":
        with lock:
            return clearinghouse(body["user"])
    if t == "spotClearinghouseState":
        u = user(body["user"])
        return {"balances": [{"coin": "USDC", "token": 0, "total": str(u["spot"]), "hold": "0", "entryNtl": "0"}]}
    if t == "extraAgents":
        u = user(body["user"])
        return [{"address": a, "name": n, "validUntil": int(time.time() * 1000) + 10**10} for a, n in u["agents"].items()]
    if t == "maxBuilderFee":
        return user(body["user"])["builder"].get(body["builder"].lower(), 0)
    if t == "userFees":
        return {"userCrossRate": "0.00045", "userAddRate": "0.00015", "dailyUserVlm": [], "feeSchedule": {}, "userSpotCrossRate": "0.0007", "userSpotAddRate": "0.0004", "activeReferralDiscount": "0"}
    return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/mock/state":
            with lock:
                return self._send(200, {"users": users, "agent_owner": agent_owner, "builder_fees": builder_fees, "log": log[-50:]})
        self._send(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        try:
            if self.path == "/info":
                return self._send(200, info(body))
            if self.path == "/exchange":
                return self._send(200, exchange(body))
            if self.path == "/mock/fund":
                with lock:
                    u = user(body["user"])
                    u["spot" if body.get("spot") else "usdc"] += float(body["amount"])
                return self._send(200, {"ok": True})
        except Exception as e:  # surface as Hyperliquid would: 422 with a message
            return self._send(422, {"error": f"{type(e).__name__}: {e}"})
        self._send(404, {})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    print(f"mock hyperliquid on :{port}, linking {MAP}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
