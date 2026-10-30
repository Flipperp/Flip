import { useApp } from "../lib/store";
import { sol } from "../lib/format";

export default function How() {
  const { config } = useApp();
  if (!config) return null;
  const c = config;
  const levs = c.leverages.map((l) => `${l}x`).join(", ");
  return (
    <div className="page docs">
      <h1>Long or short any Solana coin, filled instantly</h1>
      <p className="lede">You trade against the Flip pool, so there's no waiting for a counterparty. You close whenever you want, and you never owe anything.</p>

      <ol className="steps">
        <li>
          <h3>Fund your balance</h3>
          <p>
            Send SOL from your wallet on the Portfolio page. It's credited a few seconds after the network confirms it. Withdrawals go back to the wallet that signs.{!c.realEnabled && ` Until real trading launches, claim ${sol(c.paper.faucetAmount, 0)} test SOL instead.`}
          </p>
        </li>
        <li>
          <h3>Paste a contract address</h3>
          <p>A pump.fun coin still on its curve, a graduated one on PumpSwap, a Raydium pair, or any coin with real SOL liquidity. The price is read from the coin's own pool on-chain every second.</p>
        </li>
        <li>
          <h3>Pick a side, size and leverage</h3>
          <p>Choose {levs}. One wallet approval lets this browser sign trades for 24 hours, so trades are one click after that. Nothing is sent from your wallet when you trade.</p>
        </li>
        <li>
          <h3>Watch it, close it</h3>
          <p>
            Your P&amp;L moves live with the price times your leverage: at 2x, if the coin drops 10%, a short is up about 20%. You can close after {c.minHoldMs / 1000} seconds and the SOL is back in your balance.
          </p>
        </li>
      </ol>

      <h2>The rules</h2>
      <dl className="rules panel panel-body">
        <div>
          <dt>Leverage</dt>
          <dd>{levs} of the price move from your entry to your exit.</dd>
        </div>
        <div>
          <dt>Fair fills</dt>
          <dd>
            Every fill uses whichever is worse for you: the live on-chain price or its {c.twapWindowMs / 1000}-second average, plus a {(c.spreadBps / 100).toFixed(2)}% spread. A one-second pump moves the live price but not the average, so it can't be farmed.
          </dd>
        </div>
        <div>
          <dt>Wins and losses</dt>
          <dd>A position can win up to +{c.maxWinMult * 100}% of its stake and lose at most all of it. It closes on its own at either limit.</dd>
        </div>
        <div>
          <dt>The pool</dt>
          <dd>
            The pool is the other side of every trade. It only opens a position while it holds enough to pay every open position its maximum win, after netting longs against shorts on the same coin. Anyone can add SOL to it.
          </dd>
        </div>
        <div>
          <dt>Size limits</dt>
          <dd>
            Each side of a coin is capped by the coin's liquidity, the pool's size, and {sol(c.maxSidePerCoin, 0)} SOL. Coins under {sol(c.minLiquidity, 0)} SOL of liquidity are close-only. Each coin page shows the room left.
          </dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd>
            {c.profitFeeBps / 100}% of your profit when you close a winner, plus the spread on each fill. ${c.brand.ticker} holders pay less. Nothing on deposits or withdrawals beyond the network fee.
          </dd>
        </div>
        <div>
          <dt>Minimum</dt>
          <dd>{sol(c.minStake, 2)} SOL per trade.</dd>
        </div>
        <div>
          <dt>Fade and copy</dt>
          <dd>Every open on the live tape has a Fade button, which opens the opposite side, and a Copy button, which opens the same side. You pick the size and leverage.</dd>
        </div>
      </dl>

      <h2>When the pool steps aside</h2>
      <p className="lede">
        The pool is the other side of every pool trade, so anyone who controls a coin's price could farm it: open a short, dump their bag, collect. That's cheapest on brand-new coins. In one sample of 2,193 pump.fun graduations, the median dump came 2.2 minutes after graduation and 38% fell 80% within ten minutes. So the pool stays out of those coins, and the Arena covers them.
      </p>
      <dl className="rules panel panel-body">
        <div>
          <dt>Age</dt>
          <dd>No new pool positions until a coin is {c.risk?.seasonHours ?? 6} hours old.</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd>For coins under three days old, the top 10 wallets (not counting the curve or pool) must hold under {Math.round((c.risk?.top10Max ?? 0.3) * 100)}% of supply. Checked on-chain every few minutes.</dd>
        </div>
        <div>
          <dt>Young coins</dt>
          <dd>Under {c.risk?.youngHours ?? 24} hours old: half the usual size cap, fills use a 2-minute average instead of 30 seconds, and positions can close after 60 seconds.</dd>
        </div>
        <div>
          <dt>Crashes</dt>
          <dd>If a coin's liquidity drops {Math.round((c.risk?.liqDropMax ?? 0.4) * 100)}% from its peak in ten minutes, new positions pause. Open ones keep settling normally.</dd>
        </div>
      </dl>

      {c.arena?.enabled && (
        <>
          <h2>Arena</h2>
          <p className="lede">Up-or-down rounds on any coin, including ones too new for the pool. You play against other players; the pool never takes a side.</p>
          <dl className="rules panel panel-body">
            <div>
              <dt>Rounds</dt>
              <dd>Every {Math.round((c.arena.roundMs ?? 300_000) / 60_000)} minutes. You bet on the next round while the current one runs. Betting closes 10 seconds before it starts, so nobody bets after seeing the move.</dd>
            </div>
            <div>
              <dt>Prices</dt>
              <dd>The lock and close prices are {(c.arena.priceWindowMs ?? 10_000) / 1000}-second averages of the coin's on-chain price. Up wins if close is above lock.</dd>
            </div>
            <div>
              <dt>Payouts</dt>
              <dd>Winners split the whole pot in proportion to their bets, after a {((c.arena.feeBps ?? 300) / 100).toFixed(0)}% fee to ${c.brand.ticker} holders and the treasury. The multiples on the buttons update as bets come in.</dd>
            </div>
            <div>
              <dt>Refunds</dt>
              <dd>A round refunds every bet in full if one side is empty, the price doesn't change, or the price was unavailable at lock or close.</dd>
            </div>
            <div>
              <dt>Fair warning</dt>
              <dd>Someone who can move a coin's price can still win a round. What they can win is the other side's pot, nothing more.</dd>
            </div>
          </dl>
        </>
      )}

      {c.hl?.enabled && (
        <>
          <h2>Two routes: Hyperliquid or the Flip pool</h2>
          <p className="lede">
            Coins that also trade as a perp on Hyperliquid can go to Hyperliquid's order book from the same ticket. Coins without one trade against the Flip pool. Look for the HL perp tag.
          </p>
          <dl className="rules panel panel-body">
            <div>
              <dt>Your account, not ours</dt>
              <dd>
                Hyperliquid trades run on your own Hyperliquid account, in USDC. Flip never holds the funds. Connect an EVM wallet; Phantom's Ethereum address works, as do MetaMask and Rabby.
              </dd>
            </div>
            <div>
              <dt>Two signatures, once</dt>
              <dd>
                {c.hl.builder && (c.hl.builderFee ?? 0) > 0 ? `You approve Flip's fee cap (${((c.hl.builderFee ?? 0) / 1000).toFixed(3)}% per trade) and ` : "You approve "}
                a trading key made in your browser. That key can open and close orders but Hyperliquid won't let it withdraw. Withdrawals always need your wallet.
              </dd>
            </div>
            <div>
              <dt>Fills</dt>
              <dd>
                Market orders fill on Hyperliquid's book within {((c.hl.slippage ?? 0.03) * 100).toFixed(0)}% of the mid price, or not at all. Positions use isolated margin, so a loss on one coin can't touch the rest of your account.
              </dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>
                Hyperliquid's own trading fee, plus Flip's {((c.hl.builderFee ?? 0) / 1000).toFixed(3)}% on each fill. ${c.brand.ticker} holder tiers cut Flip's part by the same discount as the profit fee. Funding is paid or received hourly, as on any perp.
              </dd>
            </div>
            <div>
              <dt>Same coin, checked</dt>
              <dd>
                A ticker match isn't proof. Each link between a Solana coin and a Hyperliquid perp is set by hand and only routes while the coin's on-chain price and the perp's mark agree within {((c.hl.maxDivergence ?? 0.03) * 100).toFixed(0)}%. If they drift apart, or Hyperliquid stops answering, the route turns off.
              </dd>
            </div>
            <div>
              <dt>Funding your account</dt>
              <dd>Deposit USDC on Arbitrum from the ticket. It's credited to the same address in about a minute. The bridge loses deposits under 5 USDC, so Flip won't send less.</dd>
            </div>
          </dl>
        </>
      )}

      <h2>Risks, plainly</h2>
      <ul className="risks panel panel-body" style={{ paddingLeft: 32 }}>
        <li>Memecoins move fast. At 2x, a 50% move against you takes your whole stake. At 10x, a 10% move does.</li>
        <li>Prices come from the coin's own pool. A dev or whale can still move a coin; averaged fills and size caps make that expensive, not impossible.</li>
        <li>
          This is a custodial service. Deposits sit in a hot wallet and the server keeps the book. Every balance change is logged and the book is checked against the vault continuously; if anything is out of place, trading and withdrawals stop.
        </li>
        <li>Pool depositors can lose money when traders win. The share price reflects open trades in real time.</li>
        {c.hl?.enabled && <li>Hyperliquid trades always use real USDC. Perps can be liquidated, and funding costs add up on positions held for days.</li>}
        <li>Check that this kind of trading is legal where you live before using real money.</li>
      </ul>
    </div>
  );
}
