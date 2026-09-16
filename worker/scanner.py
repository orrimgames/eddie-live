#!/usr/bin/env python3
"""Eddie web scanner - ports the EddieSetup.msi desktop bot to a 24/7 web scanner.
Runs the real Cortex model (TorchScript JIT, public HF repo) over Hyperliquid perps.
Paper trading only. Serving path matches the validated Aug 30 walk-forward:
class 0 = up-barrier hit first, 1 = down first, 2 = neither (trainer label order).
EV_long = p_up*u - p_dn*d (ATR units); gate EV > 0.5*risk; $50 min EV; risk = min($1000, 2% equity).
Neutral-barrier EV = 0 (v1: quantile regressor lives in the MSI, upgrade later).
"""
import json, math, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATE_PATH = os.path.join(ROOT, "state", "state.json")
TRADES_PATH = os.path.join(ROOT, "state", "trades.json")
SCANLOG_PATH = os.path.join(ROOT, "state", "scanlog.json")
MODEL_PATH = os.path.join(ROOT, "model", "Eddie_Cortex_Best.jit.pt")
MODEL_URL = "https://huggingface.co/danielharkin21/Eddie-Cortex/resolve/main/Eddie_Cortex_Best.jit.pt"

HL = "https://api.hyperliquid.xyz/info"
T = 1024            # context bars
H = 30              # horizon bars (flatten after 30)
ATR_PERIOD = 21     # trainer label ATR period
MIN_EV_EQ_FRAC = 0.0005  # Sep 4: EV$ floor 0.05% of equity
MIN_EV_USD = 50.0   # MSI $50 min EV gate
MAX_RISK_USD = 1000.0
RISK_PCT = 0.02     # cap 2% equity
TAKER_FEE = 0.00045 # Hyperliquid taker fee per side (pessimistic)
START_EQUITY = 10000.0
MULTS = [1.0 + 0.5 * i for i in range(11)]   # combo k = 11*i+j: up=MULTS[i], down=MULTS[j]
TFS = os.environ.get("EDDIE_TFS", "5m,15m,30m,1h").split(",")  # Sep 4 MSI universe
TF_MS = {"5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000}
TOP_N = int(os.environ.get("EDDIE_TOP_N", "75"))  # universe: top perps by 24h volume
MAX_POS = 8         # max concurrent paper positions

def hl(payload, retries=3):
    for a in range(retries):
        try:
            req = urllib.request.Request(HL, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            if a == retries - 1: raise
            time.sleep(2 * (a + 1))

def candles(coin, tf, start, end):
    return hl({"type": "candleSnapshot", "req": {"coin": coin, "interval": tf,
                                                 "startTime": int(start), "endTime": int(end)}})

def get_universe():
    meta = hl({"type": "meta"})
    ctxs = hl({"type": "metaAndAssetCtxs"})
    vol = {}
    if isinstance(ctxs, list) and len(ctxs) > 1:
        for c in ctxs[1]:
            vol[c.get("coin", "")] = float(c.get("dayNtlVlm", 0) or 0)
    out = []
    for u in meta["universe"]:
        if u.get("isDelisted"): continue
        out.append({"name": u["name"], "szDec": u["szDecimals"], "maxLev": u.get("maxLeverage", 1),
                    "vol": vol.get(u["name"], 0)})
    out.sort(key=lambda x: -x["vol"])
    return out[:TOP_N]

def atr21(o, h, l, c):
    # causal ATR: mean true range over last ATR_PERIOD bars (incl. decision bar)
    n = len(c); trs = []
    s = max(1, n - ATR_PERIOD)
    for k in range(s, n):
        trs.append(max(h[k]-l[k], abs(h[k]-c[k-1]), abs(l[k]-c[k-1])))
    return sum(trs)/len(trs) if trs else 0.0

def load_model():
    import torch
    if not os.path.exists(MODEL_PATH):
        os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
        print("downloading model...", flush=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    m = torch.jit.load(MODEL_PATH, map_location="cpu"); m.eval()
    return m, torch

def infer(m, torch, win):
    # win: list of [o,h,l,c,v] (last <=1024 bars, raw). Returns probs [121,3].
    import numpy as np
    x = torch.from_numpy(np.array(win[-T:], dtype=np.float32)).unsqueeze(0)
    with torch.no_grad():
        y = m(x)
    return torch.softmax(y, dim=-1)[0].tolist()

def best_signal(probs):
    # returns dict(direction, u, d, ev, evr, p_up, p_dn, p_neu) or None
    best = None
    for k in range(121):
        i, j = divmod(k, 11)
        u, d = MULTS[i], MULTS[j]
        p_up, p_dn, p_ne = probs[k][0], probs[k][1], probs[k][2]
        for direction, ev, risk in (("long", p_up*u - p_dn*d, d), ("short", p_dn*d - p_up*u, u)):
            if ev > 0:  # Sep 4: min_ev = 0.0 (fractional, after costs)
                if best is None or evr > best["evr"]:  # rank EV$ per $ risk
                    best = {"direction": direction, "u": u, "d": d, "ev": ev,
                            "evr": ev/risk, "p_up": p_up, "p_dn": p_dn, "p_ne": p_ne}
    return best

def main():
    import numpy as np
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    state = {"equity": START_EQUITY, "positions": [], "equity_curve": [],
             "last_scan_ts": {}, "stats": {}, "started": int(time.time()*1000)}
    if os.path.exists(STATE_PATH):
        state = json.load(open(STATE_PATH))
    trades = json.load(open(TRADES_PATH)) if os.path.exists(TRADES_PATH) else []
    scanlog = json.load(open(SCANLOG_PATH)) if os.path.exists(SCANLOG_PATH) else []

    m, torch = load_model()
    uni = get_universe()
    now = int(time.time()*1000)
    # latest closed bar open-time per tf
    held_tfs = {p["tf"] for p in state["positions"]}
    all_tfs = [t for t in TF_MS if t in (set(TFS) | held_tfs)]  # keep managing off-universe holds
    closed_open = {tf: (now // TF_MS[tf]) * TF_MS[tf] - TF_MS[tf] for tf in all_tfs}
    n_scan = 0
    open_syms = {(p["symbol"], p["tf"]) for p in state["positions"]}

    for a in uni:
        sym = a["name"]
        for tf in all_tfs:
            key = f"{sym}:{tf}"
            last = state["last_scan_ts"].get(key, 0)
            sig_open = closed_open[tf]
            has_pos = (sym, tf) in open_syms
            due_scan = sig_open > last
            if not due_scan and not has_pos:
                continue
            need = T + ATR_PERIOD + 2 if due_scan else 10
            start = sig_open - (need + 1) * TF_MS[tf] if due_scan else last - 5 * TF_MS[tf]
            try:
                rows = candles(sym, tf, start, now)
            except Exception as e:
                print(f"ERR candles {key}: {e}", flush=True); continue
            if not rows: continue
            rows = [r for r in rows if r["t"] <= sig_open]  # closed bars only
            if not rows: continue
            o = [float(r["o"]) for r in rows]; h = [float(r["h"]) for r in rows]
            l = [float(r["l"]) for r in rows]; c = [float(r["c"]) for r in rows]
            v = [float(r["v"]) for r in rows]; ts = [r["t"] for r in rows]

            # --- manage open position on this symbol+tf ---
            if has_pos:
                for p in list(state["positions"]):
                    if p["symbol"] != sym or p["tf"] != tf: continue
                    for k in range(len(rows)):
                        if rows[k]["t"] <= p["last_bar_t"]: continue
                        hi, lo, cl = h[k], l[k], c[k]
                        hit_tp = (hi >= p["tp"]) if p["direction"] == "long" else (lo <= p["tp"])
                        hit_sl = (lo <= p["sl"]) if p["direction"] == "long" else (hi >= p["sl"])
                        exit_px, reason = None, None
                        if hit_tp and hit_sl: exit_px, reason = p["sl"], "SL"   # adverse assumption
                        elif hit_sl: exit_px, reason = p["sl"], "SL"
                        elif hit_tp: exit_px, reason = p["tp"], "TP"
                        p["bars"] += 1; p["last_bar_t"] = rows[k]["t"]
                        if p["bars"] >= H and exit_px is None: exit_px, reason = cl, "TIME"
                        if exit_px is not None:
                            ret = (exit_px - p["entry"]) / p["entry"] if p["direction"] == "long" else (p["entry"] - exit_px) / p["entry"]
                            ret -= 2 * TAKER_FEE
                            pnl = p["notional"] * ret
                            state["equity"] += p["margin"] + pnl - p["margin_locked_extra"]
                            trades.append({"symbol": sym, "tf": tf, "direction": p["direction"],
                                "entry": p["entry"], "exit": exit_px, "entry_t": p["entry_t"],
                                "exit_t": rows[k]["t"], "reason": reason, "pnl": round(pnl, 2),
                                "u": p["u"], "d": p["d"], "p_up": p["p_up"], "p_dn": p["p_dn"],
                                "p_ne": p["p_ne"], "ev": p["ev"], "bars": p["bars"]})
                            state["positions"].remove(p)
                            print(f"CLOSE {sym} {tf} {p['direction']} {reason} pnl={pnl:.2f}", flush=True)
                            break
                    else:
                        continue
                    break

            # --- scan for new signal ---
            if tf in TFS and due_scan and sym not in {p["symbol"] for p in state["positions"]}:  # one position per symbol (correlation guard)
                n_scan += 1
                win = [[o[k], h[k], l[k], c[k], v[k]] for k in range(len(rows))]
                try:
                    probs = infer(m, torch, win)
                except Exception as e:
                    print(f"ERR infer {key}: {e}", flush=True)
                    state["last_scan_ts"][key] = sig_open; continue
                sig = best_signal(probs)
                atr = atr21(o, h, l, c)
                entry = c[-1]
                ev_usd = risk_usd = 0.0
                if sig and atr > 0:
                    risk_frac = (sig["d"] if sig["direction"] == "long" else sig["u"]) * atr / entry
                    risk_usd = min(MAX_RISK_USD, RISK_PCT * state["equity"])
                    notional = risk_usd / risk_frac if risk_frac > 0 else 0
                    lev_cap = min(a["maxLev"], 20)
                    notional = min(notional, state["equity"] * lev_cap)
                    ev_usd = (sig["ev"] * atr / entry - 2 * TAKER_FEE) * notional  # fees both sides
                fresh = ts[-1] == sig_open and (now - (sig_open + TF_MS[tf])) < TF_MS[tf]
                took = False
                if sig and ev_usd >= max(MIN_EV_USD, MIN_EV_EQ_FRAC * state["equity"]) and fresh and \
                   len(state["positions"]) < MAX_POS and notional > 0:
                    if sig["direction"] == "long":
                        tp, sl = entry + sig["u"]*atr, entry - sig["d"]*atr
                    else:
                        tp, sl = entry - sig["d"]*atr, entry + sig["u"]*atr
                    margin = notional / lev_cap if lev_cap else notional
                    margin = min(margin, state["equity"])
                    state["equity"] -= margin
                    state["positions"].append({"symbol": sym, "tf": tf,
                        "direction": sig["direction"], "entry": entry, "tp": tp, "sl": sl,
                        "entry_t": ts[-1], "last_bar_t": ts[-1], "bars": 0, "u": sig["u"],
                        "d": sig["d"], "ev": sig["ev"], "p_up": sig["p_up"], "p_dn": sig["p_dn"],
                        "p_ne": sig["p_ne"], "notional": notional, "margin": margin,
                        "margin_locked_extra": 0, "atr": atr})
                    took = True
                    print(f"OPEN {sym} {tf} {sig['direction']} ev={ev_usd:.0f} p_up={sig['p_up']:.2f}", flush=True)
                scanlog.append({"t": now, "symbol": sym, "tf": tf, "price": entry,
                    "signal": sig["direction"] if sig else None,
                    "ev_usd": round(ev_usd, 1) if sig else 0, "took": took,
                    "p_up": round(sig["p_up"], 3) if sig else 0,
                    "p_dn": round(sig["p_dn"], 3) if sig else 0})
                state["last_scan_ts"][key] = sig_open

    # equity curve point (mark-to-market approx on close prices of positions' entry bars skipped; use cash+margin)
    mtm = state["equity"] + sum(p["margin"] for p in state["positions"])
    state["equity_curve"].append({"t": now, "eq": round(mtm, 2)})
    state["equity_curve"] = state["equity_curve"][-2000:]
    trades = trades[-500:]; scanlog = scanlog[-300:]
    # stats per tf
    st = {}
    for tr in trades:
        s = st.setdefault(tr["tf"], {"n": 0, "wins": 0, "pnl": 0.0, "gp": 0.0, "gl": 0.0})
        s["n"] += 1; s["pnl"] += tr["pnl"]
        if tr["pnl"] > 0: s["wins"] += 1; s["gp"] += tr["pnl"]
        else: s["gl"] -= tr["pnl"]
    state["stats"] = {tf: {**s, "pf": round(s["gp"]/s["gl"], 2) if s["gl"] > 0 else None} for tf, s in st.items()}
    state["last_run"] = now
    state["universe_size"] = len(uni)
    json.dump(state, open(STATE_PATH, "w"))
    json.dump(trades, open(TRADES_PATH, "w"))
    json.dump(scanlog, open(SCANLOG_PATH, "w"))
    print(f"done: scanned {n_scan} windows, {len(state['positions'])} open, equity {mtm:.2f}", flush=True)

if __name__ == "__main__":
    main()
