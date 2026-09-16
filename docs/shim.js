/* Eddie web shim: emulates the desktop FastAPI backend (/api/* + /ws/stream)
   so the real Sep-4 MSI frontend bundle runs unmodified on GitHub Pages.
   Data: worker state JSON (paper trading) + Hyperliquid public API/WS. */
(function () {
  "use strict";
  var HL_REST = "https://api.hyperliquid.xyz";
  var HL_WS = "wss://api.hyperliquid.xyz/ws";
  var TF_LIST = ["1m", "3m", "5m", "15m", "30m", "1h"];
  var TF_SEC = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400 };
  var ATR_MULTS = [1.0,1.5,2.0,2.5,3.0,3.5,4.0,4.5,5.0,5.5,6.0];
  var MAX_BARS = 30, TAKER = 0.00045;

  var state = null, trades = [], mids = {}, metaSymbols = null;
  var cfgOverlay = {};
  try { cfgOverlay = JSON.parse(localStorage.getItem("eddie_cfg") || "{}"); } catch (e) {}

  var nativeFetch = window.fetch.bind(window);
  var STATE_SOURCES = ["./state/state.json", "https://raw.githubusercontent.com/orrimgames/eddie-live/main/state/state.json"];
  var TRADES_SOURCES = ["./state/trades.json", "https://raw.githubusercontent.com/orrimgames/eddie-live/main/state/trades.json"];
  function fetchFirst(sources, ok) {
    var i = 0;
    function tryNext() {
      if (i >= sources.length) return;
      nativeFetch(sources[i] + "?t=" + Date.now()).then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }).then(ok).catch(function () { i++; tryNext(); });
    }
    tryNext();
  }
  function fetchState() { fetchFirst(STATE_SOURCES, function (s) { state = s; }); }
  function fetchTrades() { fetchFirst(TRADES_SOURCES, function (t) { trades = Array.isArray(t) ? t : []; }); }
  fetchState(); fetchTrades();
  setInterval(fetchState, 20000); setInterval(fetchTrades, 60000);

  // ---- live mids via Hyperliquid allMids WS ----
  (function midsLoop() {
    var ws;
    try { ws = new NativeWebSocket(HL_WS); } catch (e) { setTimeout(midsLoop, 5000); return; }
    ws.onopen = function () { ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } })); };
    ws.onmessage = function (ev) {
      try { var m = JSON.parse(ev.data); if (m.channel === "allMids" && m.data && m.data.mids) mids = m.data.mids; } catch (e) {}
    };
    ws.onclose = function () { setTimeout(midsLoop, 3000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  })();

  function meta() {
    if (metaSymbols) return Promise.resolve(metaSymbols);
    return nativeFetch(HL_REST + "/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "meta" }) })
      .then(function (r) { return r.json(); })
      .then(function (m) { metaSymbols = m.universe.map(function (u) { return u.name; }); return metaSymbols; });
  }

  function jsonResp(obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  }

  function mark(sym) { var v = parseFloat(mids[sym]); return isFinite(v) ? v : null; }

  function positionsList() {
    if (!state) return [];
    return state.positions.map(function (p, i) {
      var mk = mark(p.symbol);
      var dir = p.direction === "long" ? 1 : -1;
      var size = p.notional / p.entry;
      return {
        trade_id: i + 1, symbol: p.symbol, tf: p.tf, direction: p.direction,
        entry_px: p.entry, size: size, notional: p.notional,
        tp_px: p.tp, sl_px: p.sl,
        p_win: dir === 1 ? p.p_up : p.p_dn, p_loss: dir === 1 ? p.p_dn : p.p_up, p_neutral: p.p_ne,
        kelly: p.ev || 0, kelly_used: p.ev || 0, leverage: p.notional / p.margin,
        margin: p.margin, corr_scale: 1.0,
        entry_time: p.entry_t / 1000, bars_held: p.bars || 0, max_bars: MAX_BARS,
        up_mult: p.u, down_mult: p.d, mark: mk,
        unrealized_pnl: mk ? (mk - p.entry) / p.entry * p.notional * dir : 0
      };
    });
  }

  function statusObj() {
    var pos = positionsList();
    var cash = state ? state.equity : 0;
    var marginUsed = pos.reduce(function (a, p) { return a + p.margin; }, 0);
    var upnl = pos.reduce(function (a, p) { return a + (p.unrealized_pnl || 0); }, 0);
    var eq = cash + marginUsed + upnl;
    var last = state && state.last_run ? { combo: null, ts: state.last_run / 1000, opportunities: 0 } : { combo: null, ts: 0, opportunities: 0 };
    return {
      trading_enabled: true, halted: false, exchange_ready: true,
      equity: eq, margin_used: marginUsed,
      margin_available: Math.max(eq - marginUsed, 0), withdrawable: Math.max(cash, 0),
      avg_correlation: null, mode: "paper",
      open_positions: pos.length, pending_entries: 0,
      models_ready: true, scan_count: state ? Object.keys(state.last_scan_ts || {}).length : 0,
      last_scan: last
    };
  }

  function availabilityObj() {
    var combos = [];
    return meta().then(function (syms) {
      syms.forEach(function (s) { TF_LIST.forEach(function (t) { combos.push(s + ":" + t); }); });
      return { ready: combos.length, total: combos.length, ready_combos: combos,
               priority_ready: 0, priority_total: 0, ws_healthy: true, weight_used: 0 };
    });
  }

  var CONFIG_BASE = {
    mode: "paper", kelly_threshold: 0.04, kelly_fraction: 0.25,
    max_risk_per_trade: 0.02, max_open_positions: 12, taker_fee: TAKER,
    entry_order_timeout_s: 5.0, max_position_bars: MAX_BARS,
    symbols: [], timeframes: TF_LIST, wallet_address: "",
    telegram_enabled: false, instance_id: "eddie-web", instance_priority: 1, peers: []
  };

  function closedTrades() { return trades.filter(function (t) { return t.status === "closed" || t.exit_px != null || t.pnl != null; }); }

  function performanceObj() {
    var c = closedTrades();
    var pnls = c.map(function (t) { return t.pnl || 0; });
    var wins = pnls.filter(function (x) { return x > 0; }), losses = pnls.filter(function (x) { return x < 0; });
    var gw = wins.reduce(function (a, b) { return a + b; }, 0), gl = -losses.reduce(function (a, b) { return a + b; }, 0);
    var n = pnls.length;
    var mean = n ? pnls.reduce(function (a, b) { return a + b; }, 0) / n : 0;
    var curve = state ? (state.equity_curve || []) : [];
    var peak = -Infinity, mdd = 0, mddp = 0;
    curve.forEach(function (e) { peak = Math.max(peak, e.eq); mdd = Math.max(mdd, peak - e.eq); if (peak > 0) mddp = Math.max(mddp, (peak - e.eq) / peak); });
    return {
      n_trades: n, wins: wins.length, losses: losses.length,
      win_rate: n ? wins.length / n : 0,
      profit_factor: gl > 0 ? gw / gl : (gw > 0 ? null : 0),
      realized_pnl: pnls.reduce(function (a, b) { return a + b; }, 0),
      total_pnl: pnls.reduce(function (a, b) { return a + b; }, 0),
      total_fees: c.reduce(function (a, t) { return a + (t.fees || 0); }, 0),
      open_fees: 0, closed_fees: c.reduce(function (a, t) { return a + (t.fees || 0); }, 0),
      avg_win: wins.length ? gw / wins.length : 0, avg_loss: losses.length ? -gl / losses.length : 0,
      expectancy: mean, trade_sharpe: null, sortino: null, sqn: null,
      payoff_ratio: null, best_trade: n ? Math.max.apply(null, pnls) : null,
      worst_trade: n ? Math.min.apply(null, pnls) : null,
      max_drawdown: mdd, max_drawdown_pct: mddp,
      prediction_metrics: null, exit_reasons: {}
    };
  }

  function apiRoute(u, init) {
    var path = u.pathname, q = u.searchParams;
    var method = (init && init.method) || "GET";
    if (path === "/api/health") return Promise.resolve(jsonResp({ ok: true }));
    if (path === "/api/status") return Promise.resolve(jsonResp(Object.assign(statusObj(), { availability: null })));
    if (path === "/api/universe") return meta().then(function (syms) {
      var combos = [];
      syms.forEach(function (s) { TF_LIST.forEach(function (t) { combos.push({ symbol: s, tf: t, synced: true }); }); });
      return jsonResp({ symbols: syms, timeframes: TF_LIST, atr_multipliers: ATR_MULTS, combos: combos });
    });
    if (path === "/api/candles") {
      var sym = q.get("symbol"), tf = q.get("tf");
      var sec = TF_SEC[tf] || 60, end = Date.now(), start = end - 1050 * sec * 1000;
      return nativeFetch(HL_REST + "/info", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin: sym, interval: tf, startTime: start, endTime: end } }) })
        .then(function (r) { return r.json(); }).then(function (rows) {
          return jsonResp({ symbol: sym, tf: tf, synced: true, candles: rows.map(function (r) {
            return { time: Math.floor(r.t / 1000), open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v };
          }) });
        });
    }
    if (path === "/api/l2") {
      var s2 = q.get("symbol");
      return nativeFetch(HL_REST + "/info", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin: s2 }) }).then(function (r) { return r.json(); }).then(jsonResp);
    }
    if (path === "/api/positions") return Promise.resolve(jsonResp(positionsList()));
    if (path === "/api/trades") {
      return Promise.resolve(jsonResp(trades.slice(-500).reverse().map(function (t, i) {
        return Object.assign({ id: i + 1, mode: "paper", status: "closed", fees: 0, bars_held: 0 }, t);
      })));
    }
    if (path === "/api/performance") return Promise.resolve(jsonResp(performanceObj()));
    if (path === "/api/equity") {
      var cur = state ? (state.equity_curve || []) : [];
      return Promise.resolve(jsonResp(cur.map(function (e) { return { ts: e.t / 1000, equity: e.eq }; })));
    }
    if (path === "/api/config" && method === "GET") return Promise.resolve(jsonResp(Object.assign({}, CONFIG_BASE, cfgOverlay)));
    if (path === "/api/config" && method === "POST") {
      return new Response(init.body).text().then(function (b) {
        try { cfgOverlay = Object.assign(cfgOverlay, JSON.parse(b || "{}")); localStorage.setItem("eddie_cfg", JSON.stringify(cfgOverlay)); } catch (e) {}
        return jsonResp({ ok: true });
      });
    }
    if (path.indexOf("/api/control/") === 0) return Promise.resolve(jsonResp(statusObj()));
    if (path === "/api/correlations") return Promise.resolve(jsonResp({ pairs: [], avg: null }));
    if (path === "/api/paper/reset") return Promise.resolve(jsonResp({ ok: true, balance: null, note: "web clone is read-only; worker-managed paper account" }));
    if (method === "POST") return Promise.resolve(jsonResp({ ok: true, note: "read-only web clone" }));
    return Promise.resolve(jsonResp({ detail: "not available in web clone" }, 404));
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    try { var u = new URL(url, location.href); if (u.pathname.indexOf("/api/") === 0) return apiRoute(u, init); } catch (e) {}
    return nativeFetch(input, init);
  };

  // ---- WebSocket emulation for /ws/stream ----
  var NativeWebSocket = window.WebSocket;
  function ShimWebSocket(url) {
    var u = String(url);
    if (u.indexOf("/ws/stream") === -1) return new NativeWebSocket(u);
    var self = this;
    this.readyState = 0; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this._sub = null; this._candles = []; this._l2 = null; this._hlws = null; this._subKey = null;
    setTimeout(function () { self.readyState = 1; if (self.onopen) self.onopen({}); }, 0);
    this._timer = setInterval(function () {
      if (self.readyState !== 1 || !self.onmessage) return;
      availabilityObj().then(function (avail) {
        var payload = { type: "tick", ts: Date.now() / 1000,
          status: Object.assign(statusObj(), { booting: false, cluster: { peers: [], leader: "eddie-web", is_leader: true } }),
          availability: avail, positions: positionsList() };
        if (self._sub) {
          payload.sub = self._sub; payload.synced = true; payload.gap_pending = false;
          if (self._candles.length) payload.candles = self._candles.slice(-3);
          if (self._l2) payload.l2 = self._l2;
        }
        self.onmessage({ data: JSON.stringify(payload) });
      });
    }, 250);
  }
  ShimWebSocket.prototype.send = function (data) {
    try {
      var m = JSON.parse(data);
      if (m && m.type === "subscribe" && m.symbol && m.tf) {
        this._sub = { symbol: m.symbol, tf: m.tf };
        this._subscribeHL();
      }
    } catch (e) {}
  };
  ShimWebSocket.prototype._subscribeHL = function () {
    var self = this, key = this._sub.symbol + ":" + this._sub.tf;
    if (key === this._subKey) return;
    this._subKey = key; this._candles = [];
    if (this._hlws) { try { this._hlws.close(); } catch (e) {} }
    // REST backfill for chart candles
    nativeFetch(HL_REST + "/info", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: this._sub.symbol, interval: this._sub.tf,
        startTime: Date.now() - (TF_SEC[this._sub.tf] || 60) * 1050 * 1000, endTime: Date.now() } }) })
      .then(function (r) { return r.json(); }).then(function (rows) {
        if (self._subKey !== key) return;
        self._candles = rows.map(function (r) { return { time: Math.floor(r.t / 1000), open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }; });
      }).catch(function () {});
    var ws;
    try { ws = new NativeWebSocket(HL_WS); } catch (e) { return; }
    this._hlws = ws;
    ws.onopen = function () {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: self._sub.symbol, interval: self._sub.tf } }));
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: self._sub.symbol } }));
    };
    ws.onmessage = function (ev) {
      if (self._subKey !== key) return;
      try {
        var m = JSON.parse(ev.data);
        if (m.channel === "candle" && m.data) {
          var r = m.data, c = { time: Math.floor(r.t / 1000), open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v };
          var last = self._candles[self._candles.length - 1];
          if (last && last.time === c.time) self._candles[self._candles.length - 1] = c; else self._candles.push(c);
          if (self._candles.length > 1100) self._candles = self._candles.slice(-1050);
        } else if (m.channel === "l2Book" && m.data) {
          self._l2 = m.data;
        }
      } catch (e) {}
    };
    ws.onclose = function () { if (self._subKey === key) setTimeout(function () { self._subKey = null; self._subscribeHL(); }, 3000); };
  };
  ShimWebSocket.prototype.close = function () {
    this.readyState = 3; clearInterval(this._timer);
    if (this._hlws) { try { this._hlws.close(); } catch (e) {} }
    if (this.onclose) this.onclose({});
  };
  ShimWebSocket.prototype.addEventListener = function (type, fn) { this["on" + type] = fn; };
  ShimWebSocket.prototype.removeEventListener = function () {};
  window.WebSocket = ShimWebSocket;
})();
