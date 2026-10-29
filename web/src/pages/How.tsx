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
            Send SOL from your wallet on the Portfolio page. It's credited a few seconds after the network confirms it. Withdrawals go back to the wallet that signs. Want to try it first? Switch to Practice at the top and claim {sol(c.paper.faucetAmount, 0)} paper SOL.
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

      <h2>Risks, plainly</h2>
      <ul className="risks panel panel-body" style={{ paddingLeft: 32 }}>
        <li>Memecoins move fast. At 2x, a 50% move against you takes your whole stake. At 10x, a 10% move does.</li>
        <li>Prices come from the coin's own pool. A dev or whale can still move a coin; averaged fills and size caps make that expensive, not impossible.</li>
        <li>
          This is a custodial service. Deposits sit in a hot wallet and the server keeps the book. Every balance change is logged and the book is checked against the vault continuously; if anything is out of place, trading and withdrawals stop.
        </li>
        <li>Pool depositors can lose money when traders win. The share price reflects open trades in real time.</li>
        <li>Check that this kind of trading is legal where you live before using real money.</li>
      </ul>
    </div>
  );
}
