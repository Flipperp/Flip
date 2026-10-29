import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

-- User cash balances, per mode, in lamports.
CREATE TABLE IF NOT EXISTS accounts (
  wallet TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('real','paper')),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  PRIMARY KEY (wallet, mode)
);

-- System buckets per mode. Conservation invariant:
-- sum(accounts) + pool_cash + holders_pot + treasury + locked + pending_withdrawals
--   == external_in - external_out
CREATE TABLE IF NOT EXISTS book (
  mode TEXT NOT NULL,
  bucket TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mode, bucket)
);

CREATE TABLE IF NOT EXISTS pool_shares (
  wallet TEXT NOT NULL,
  mode TEXT NOT NULL,
  shares INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
  PRIMARY KEY (wallet, mode)
);

CREATE TABLE IF NOT EXISTS markets (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL,          -- pumpfun | pumpswap | raydium_amm | raydium_cpmm | jupiter
  source TEXT NOT NULL,         -- JSON describing which accounts to read
  supply REAL NOT NULL DEFAULT 0,
  decimals INTEGER NOT NULL DEFAULT 6,
  added_at INTEGER NOT NULL,
  last_viewed INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  leverage INTEGER NOT NULL,
  stake INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  exit_price REAL,
  closed_at INTEGER,
  pnl INTEGER,            -- gross P&L paid by/to the pool
  fee INTEGER,            -- profit fee charged
  payout INTEGER,         -- credited back to the user
  close_reason TEXT,      -- manual | max_win | liquidated | admin
  origin TEXT NOT NULL DEFAULT 'direct', -- direct | fade:<id> | copy:<id>
  tier INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS positions_open ON positions(status, mode, mint);
CREATE INDEX IF NOT EXISTS positions_wallet ON positions(wallet, mode, status);
CREATE INDEX IF NOT EXISTS positions_closed ON positions(mode, closed_at);

-- Every balance-moving event. Used for the tape, history and audits.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL,
  wallet TEXT,
  mint TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_mode_ts ON events(mode, id);

CREATE TABLE IF NOT EXISTS deposits (
  sig TEXT NOT NULL,
  ix INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  amount INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user', -- user | creator_fee | ignored
  ts INTEGER NOT NULL,
  PRIMARY KEY (sig, ix)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  sig TEXT,
  last_valid_height INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status);

CREATE TABLE IF NOT EXISTS nonces (
  signer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (signer, nonce)
);

-- Session keys: a wallet authorizes a browser keypair to trade (never to withdraw).
CREATE TABLE IF NOT EXISTS sessions (
  session_pubkey TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_claims (
  wallet TEXT PRIMARY KEY,
  last_claim INTEGER NOT NULL
);

-- Holder time-weighted balances.
CREATE TABLE IF NOT EXISTS holder_epochs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_snapshot_at INTEGER,
  payout_total INTEGER,
  rebate_total INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE TABLE IF NOT EXISTS holder_weights (
  epoch_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,     -- sum(balance_tokens * ms)
  last_balance REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (epoch_id, wallet)
);
CREATE TABLE IF NOT EXISTS holder_rewards (
  epoch_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  reward INTEGER NOT NULL DEFAULT 0,
  rebate INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (epoch_id, wallet)
);
-- Latest known token balance per wallet, for tiers.
CREATE TABLE IF NOT EXISTS holder_balances (
  wallet TEXT PRIMARY KEY,
  balance REAL NOT NULL,
  twab REAL NOT NULL DEFAULT 0,      -- tier balance: min(prev epoch avg, current epoch avg)
  prev_avg REAL NOT NULL DEFAULT 0,  -- average balance over the last closed epoch
  updated_at INTEGER NOT NULL
);
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

export function kvGet(db: DB, k: string): string | undefined {
  const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return r?.v;
}

export function kvSet(db: DB, k: string, v: string) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}
