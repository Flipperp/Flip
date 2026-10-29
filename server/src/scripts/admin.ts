import "dotenv/config";

/**
 * Admin CLI against a running server.
 *   npm run admin -- book
 *   npm run admin -- halt real "investigating"
 *   npm run admin -- resume real
 *   npm run admin -- close 123
 *   npm run admin -- close_market real <mint>
 *   npm run admin -- delist <mint> | list <mint>
 *   npm run admin -- treasury_to real <lamports> <wallet>
 *   npm run admin -- close_epoch
 */
const [op, ...args] = process.argv.slice(2);
const base = process.env.ADMIN_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const body: Record<string, unknown> = {};
switch (op) {
  case "halt":
    body.mode = args[0];
    body.reason = args[1] ?? "admin";
    break;
  case "resume":
    body.mode = args[0];
    break;
  case "close":
    body.id = Number(args[0]);
    break;
  case "close_market":
    body.mode = args[0];
    body.mint = args[1];
    break;
  case "delist":
  case "list":
    body.mint = args[0];
    break;
  case "treasury_to":
    body.mode = args[0];
    body.amount = Number(args[1]);
    body.wallet = args[2];
    break;
}
const r = await fetch(`${base}/api/admin/${op}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-key": process.env.ADMIN_KEY ?? "" },
  body: JSON.stringify(body),
});
console.log(r.status, JSON.stringify(await r.json(), null, 2));
