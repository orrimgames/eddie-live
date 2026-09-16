# Eddie web port - build state (2026-09-16)

GOAL (Daniel, iMessage 10:14 AM): "port everything to a website so I can see it scanning and trading 24 7".
Zero spend. Paper trading only - real money gated on his explicit approval.

## WHAT EXISTS HERE (all tested)
- worker/scanner.py - the bot. Runs the REAL Cortex JIT (Eddie_Cortex_Best.jit.pt, epoch 8995,
  loss 0.804, public HF danielharkin21/Eddie-Cortex) over Hyperliquid's free public API.
  Universe: top 75 perps by 24h volume, TFs 5m/15m/30m/1h/4h.
  TESTED LIVE: first real run opened BTC 4h long (EV $115, p_up .53), ATOM 1h short, ATOM 4h long.
  Env overrides for tests: EDDIE_TOP_N, EDDIE_TFS.
- model/Eddie_Cortex_Best.jit.pt - the checkpoint (md5 c5653e549f2ab77b0d7da94d55849da6).
- state/ - LIVE paper state from first run (3 open positions). Carry into the repo: instant content.
- site/index.html - dashboard (dark, mobile-first). Live prices via HL websocket in-browser,
  state/trades/scanlog JSON from raw.githubusercontent (const RAW at top - SET OWNER/REPO),
  equity curve, positions (entry/TP/SL, x/30 bars, p up/dn/neu), scan feed, trades, per-TF stats.
- .github/workflows/scan.yml - cron every 5 min, torch cpu, commits state JSON each run.

## SERVING PATH (validated, do not change casually)
- Class order from trainer: 0=up hit first, 1=down first, 2=neither. Softmax outside JIT.
- Combos: k=11i+j, up=MULTS[i], down=MULTS[j], mults 1.0..6.0 step .5. Slow axis = up.
- EV_long = p_up*u - p_dn*d (ATR units); gate EV > 0.5*risk; also $50 min EV USD.
- risk$ = min($1000, 2% equity); notional = risk$/(SL frac), capped equity*min(maxLev,20).
- ATR: causal ATR-21 (trainer label period; Aug 30 walk-forward validated w/ causal ATR and found edge).
- Entry at signal-bar close, only if bar is latest closed (stale signals skipped).
- Same-bar TP+SL => SL (adverse). 30-bar flatten. Taker fee 0.045%/side in PnL.
- One position per symbol (any TF) - simple correlation guard.
- Neutral-EV = 0 (v1). UPGRADE PATH: quantile regressor for neutral EV lives only in the MSI.

## KNOWN GAPS / TODO
1. Quantile regressor (neutral EV, .25/.75 quantile per Daniel's write-up) - in EddieSetup.msi
   (Drive 1Zklaiw0DkDh1VYbRijUyy_cCZi8nFsoi, danielharkin21 account, 483MB; drive tool caps 25MB;
   public curl hits Google sign-in). Get via cloud browser w/ saved Google session, or ask Daniel.
2. MSI also has: exact strict perp filter, L2 slippage engine, OCO via HyPaper testnet, Telegram bot.
3. GitHub deploy (NEXT RUN, see below).

## DEPLOY PLAN (next run)
1. Cloud browser (write lease), sign into GitHub as orrimgames (vault: orrimgames-github).
2. Create PUBLIC repo orrimgames/eddie-live. Public = free unlimited Actions minutes.
3. Create a classic PAT (repo+workflow scopes) via web UI, save with `tools vault update`
   on orrimgames-github-pat, then use git CLI for everything else.
4. Push this tree. Set RAW in site/index.html to raw.githubusercontent.com/orrimgames/eddie-live/main/state.
   Serve Pages from the site/ folder (move to docs/ if needed) OR separate orrimgames.github.io/eddie path.
5. Run workflow_dispatch once, verify state commits + raw URLs + Pages. Screenshot. Report URL to parent.
6. Daniel-facing caveats for main: paper only; 4h is the only walk-forward-validated TF (site shows
   per-TF stats so live evidence accrues); GitHub cron can lag 5-15 min under load; neutral-EV=0 for now.
