"""End-to-end browser test of the Hyperliquid route against scripts/mock_hyperliquid.py.

Starts nothing itself. Run the Flip demo server with HL_API_URL pointing at the mock (see the
mock file header), then:  python3 scripts/hl_e2e.py [demo mint]
A fake EVM wallet signs in Python like MetaMask would; screenshots land in $OUT (default /tmp).
"""
import json, sys, time, urllib.request
from eth_account import Account
from eth_account.messages import encode_typed_data
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8787"
MOCK = "http://127.0.0.1:8790"
MINT = sys.argv[1] if len(sys.argv) > 1 else "DemoGoose2222222222222222222222222222222pump"
import os
OUT = os.environ.get("OUT", "/tmp")
acct = Account.from_key("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
state = {"chain": "0x1", "sent": []}

def mock(path, body):
    req = urllib.request.Request(MOCK + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))

def evm(method, params):
    params = params or []
    if method in ("eth_requestAccounts", "eth_accounts"): return [acct.address]
    if method == "eth_chainId": return state["chain"]
    if method == "wallet_switchEthereumChain": state["chain"] = params[0]["chainId"]; return None
    if method == "eth_signTypedData_v4":
        assert params[0].lower() == acct.address.lower()
        return "0x" + acct.sign_message(encode_typed_data(full_message=json.loads(params[1]))).signature.hex().removeprefix("0x")
    if method == "eth_call": return hex(1000 * 10**6)
    if method == "eth_sendTransaction":
        tx = params[0]; data = tx["data"]
        assert data.startswith("0xa9059cbb"), data
        to = "0x" + data[10+24:10+64]; amt = int(data[10+64:], 16)
        assert to.lower() == "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7", to
        assert tx["to"].lower() == "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
        state["sent"].append(amt)
        mock("/mock/fund", {"user": acct.address, "amount": amt / 1e6})
        return "0x" + "ab" * 32
    raise Exception("unsupported " + method)

INIT = """
window.phantom = { ethereum: {
  isPhantom: true,
  _l: {},
  on(e, f) { (this._l[e] = this._l[e] || []).push(f); },
  removeListener() {},
  async request({ method, params }) {
    const r = await window.__evm(method, params || []);
    if (r && r.__error) { const e = new Error(r.__error); e.code = r.code; throw e; }
    return r;
  },
}};
"""

def shot(pg, name):
    pg.screenshot(path=f"{OUT}/{name}.png", full_page=False)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    ctx.expose_function("__evm", lambda m, pr: evm(m, pr))
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.goto(f"{BASE}/trade/{MINT}")
    pg.wait_for_selector(".hl-ticket", timeout=20000)
    time.sleep(2)
    shot(pg, "01-connect")
    pg.get_by_role("button", name="Connect EVM wallet").click()
    pg.wait_for_selector("text=Your Hyperliquid account is empty", timeout=15000)
    shot(pg, "02-deposit")
    pg.fill("#hl-dep", "3")
    assert pg.get_by_role("button", name="Minimum 5 USDC").is_disabled()
    pg.fill("#hl-dep", "50")
    pg.get_by_role("button", name="Deposit 50 USDC").click()
    pg.wait_for_selector("text=Turn on trading (2 signatures)", timeout=20000)
    assert state["chain"] == "0xa4b1" and state["sent"] == [50_000_000], state
    shot(pg, "03-setup")
    pg.get_by_role("button", name="Turn on trading (2 signatures)").click()
    pg.wait_for_selector("#hl-size", timeout=20000)
    time.sleep(1)
    shot(pg, "04-ready")
    pg.fill("#hl-size", "20")
    pg.locator(".hl-ticket .lev-row button", has_text="5x").click()
    btn = pg.locator(".hl-ticket .btn-long")
    print("button:", btn.inner_text())
    btn.click()
    pg.wait_for_function("() => [...document.querySelectorAll('.t-bottom button[role=tab]')].some(b => /Hyperliquid \\(1\\)/.test(b.textContent))", timeout=20000)
    pg.locator(".t-bottom button[role=tab]", has_text="Hyperliquid").click()
    time.sleep(1.5)
    shot(pg, "05-position")
    st = json.load(urllib.request.urlopen(MOCK + "/mock/state"))
    u = st["users"][acct.address.lower()]
    print("position:", json.dumps(u["pos"]), "usdc:", round(u["usdc"], 4))
    pg.locator(".t-bottom .btn", has_text="Close").click()
    pg.wait_for_selector("text=No open Hyperliquid positions", timeout=20000)
    shot(pg, "06-closed")
    st = json.load(urllib.request.urlopen(MOCK + "/mock/state"))
    print("log:", [tuple(x[:2]) for x in st["log"]])
    print("builder fees:", st["builder_fees"])
    print("final usdc:", round(st["users"][acct.address.lower()]["usdc"], 4))
    print("page errors:", errors)
    b.close()
