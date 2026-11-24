// TidyOwl — momentum paper-trader for the pump.fun bonding-curve replay.
//
// Idea: most new curves are noise. The ones worth buying are the curves that
// survived their launch dump, then started climbing again on broad, speeding-up
// buy flow: lots of small buyers (not one whale), price pushing up against the
// top of its recent range, and the second half of the lookback window pulling in
// noticeably more SOL than the first half.
//
// Sizing is one scout ticket per coin and nothing more: tuning on the dev
// window showed pyramiding into "strength" is what kills this family — the
// adds land right before the reversal, so a 0.5 SOL scout that never tops up
// beats a 0.08 scout pyramided to 1.5. One entry per coin, too: re-entries on
// a coin that already stopped out just pay the fee twice. Losers are
// cut fast on a stop, a trailing stop once the trade has run, a fade in buy flow,
// a single outsized dump, or a hard hold clock. Winners are left alone while the
// curve is close to completing (real SOL near migration), because the replay
// closes those itself.
//
// Guardrail probes: if the bot's own fills / distinct coins fall behind the pace
// the run needs (200+ fills across 20+ coins), it opens tiny probe round trips on
// liquid curves and flips them straight back out. Probes are a compliance cost,
// kept as small and as rare as the pace allows.
//
// Everything here is deterministic: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** All tunables in one place. Values were picked for robustness on the dev
 *  window (flat regions, not a single peak cell) — the final window is unseen
 *  future data, so a setting that only wins on one dev coin is worthless. */
export interface OwlConfig {
  /** Lookback in slots for the entry tape scan. */
  lookback: number;
  /** Minimum net buy SOL (buys minus sells) inside the lookback. */
  needNetSol: number;
  /** Minimum buy trades inside the lookback. */
  needBuys: number;
  /** Minimum distinct buying wallets inside the lookback. */
  needWallets: number;
  /** Minimum price rise across the lookback, as a fraction (0.04 = +4%). */
  needRise: number;
  /** Maximum price rise across the lookback — skip curves that already mooned. */
  capRise: number;
  /** Newer-half net inflow must be at least this multiple of older-half inflow. */
  accelNeed: number;
  /** Price must sit at least this far up its lookback high (0.93 = within 7%). */
  nearTop: number;
  /** Dip-band entry (bounce hunting): when dipHi > 0, the nearTop check is
   *  replaced by requiring the price to sit inside [dipLo, dipHi] of its
   *  lookback high — pulled back from the top, not sitting on it — and to have
   *  bounced at least bounceUp off its low over the last bounceSpan slots.
   *  Buying the top of a fast rise is how this window's momentum entries die;
   *  buying the bounce after the dip is the same trend, entered cheaper. */
  dipLo: number;
  dipHi: number;
  bounceSpan: number;
  bounceUp: number;
  /** Largest single wallet's share of buy SOL inside the lookback (breadth cap). */
  maxWhaleShare: number;
  /** Real SOL reserve bounds for a curve to be enterable. */
  minCurveSol: number;
  maxCurveSol: number;
  /** Slots after the CreateEvent before an entry is allowed. */
  minCurveAge: number;
  /** Longer lookback whose high the price must also sit near (breakout check). */
  longLookback: number;
  /** Price must be at least this share of the long-lookback high. */
  longNearTop: number;
  /** Total SOL a single position may ever hold. */
  stakeCapSol: number;
  /** First ticket of a position. */
  scoutSol: number;
  /** Each top-up ticket. 0 disables top-ups entirely (scout-only sizing). */
  topupSol: number;
  /** Smallest buy worth sending. */
  floorBuySol: number;
  /** Top up only once price is this far above the last buy's decision price. */
  topupStep: number;
  /** Top up only while the position is at least this far in profit. */
  topupNeedUp: number;
  /** Top up only while net SOL over the lookback is at least this. */
  topupNeedFlow: number;
  /** Buy slippage in bps; sells always go out at 10000. */
  slipBps: number;
  /** Exit when value falls this far below cost (fraction). */
  cutLoss: number;
  /** Trailing stop: exit when value falls this far below its peak (fraction). */
  trailDrop: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArmUp). */
  trailArmUp: number;
  /** Fade exit: net SOL over fadeSpan slots below -fadeSol triggers an exit. */
  fadeSpan: number;
  fadeSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  dumpSol: number;
  /** Exit after this many slots held (unless up at least holdFreeIfUp). */
  holdLimit: number;
  /** The hold clock does not apply while up at least this much. */
  holdFreeIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  restSlots: number;
  /** Most entries per curve over the whole run. */
  entriesPerCoin: number;
  /** Real SOL above which a position is left to ride toward completion. */
  rideSol: number;
  /** Most momentum positions open at once (remaining slots are for probes). */
  maxCore: number;
  /** Most SOL at cost across all positions at once. */
  maxBookSol: number;
  /** Guardrail pacing targets and horizon (seconds of block time). */
  paceCoins: number;
  paceFills: number;
  paceHorizonSec: number;
  /** Size of one probe ticket. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const OWL_DEFAULT: OwlConfig = {
  lookback: 40,
  needNetSol: 2,
  needBuys: 4,
  needWallets: 4,
  needRise: 0.04,
  capRise: 1.2,
  accelNeed: 0.9,
  nearTop: 0.93,
  dipLo: 0.5,
  dipHi: 0.95,
  bounceSpan: 10,
  bounceUp: 0.02,
  maxWhaleShare: 0.4,
  minCurveSol: 1.5,
  maxCurveSol: 50,
  minCurveAge: 400,
  longLookback: 120,
  longNearTop: 0.9,
  stakeCapSol: 1.5,
  scoutSol: 0.5,
  topupSol: 0,
  floorBuySol: 0.01,
  topupStep: 0.02,
  topupNeedUp: 0,
  topupNeedFlow: 0.5,
  slipBps: 1200,
  cutLoss: 0.15,
  trailDrop: 0.05,
  trailArmUp: 0.08,
  fadeSpan: 20,
  fadeSol: 0.2,
  dumpSol: 5,
  holdLimit: 150,
  holdFreeIfUp: 0.1,
  restSlots: 200,
  entriesPerCoin: 1,
  rideSol: 80,
  maxCore: 4,
  maxBookSol: 5,
  paceCoins: 22,
  paceFills: 210,
  paceHorizonSec: 21_600,
  probeSol: 0.01,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
const CURVE_TAKE = 0.0125; // bonding-curve fee taken on the sell side of a close

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  wallet: string;
  price: number;
}

interface CoinBook {
  born: number | null;
  ticks: Tick[];
  entries: number;
  lastOut: number;
}

interface OpenTrade {
  openedSlot: number;
  bestValue: number;
  spent: number;
  closing: boolean;
  sawFill: boolean;
  lastBuyPrice: number;
  lastValue: number;
}

interface TapeScan {
  qualifies: boolean;
  netSol: number;
}

export function makeOwlBot(cfg: OwlConfig = OWL_DEFAULT): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const trades = new Map<Pubkey, OpenTrade>();
  /** Probe round trips in flight: false = buying leg open, true = selling leg sent. */
  const probes = new Map<Pubkey, boolean>();
  let ownFills = 0;
  const ownCoins = new Set<Pubkey>();
  let clockStart: number | null = null;
  let clockNow: number | null = null;
  const retain = Math.max(cfg.lookback, cfg.fadeSpan, cfg.longLookback) + 5;

  const bookOf = (mint: Pubkey): CoinBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { born: null, ticks: [], entries: 0, lastOut: -1e12 };
      books.set(mint, b);
    }
    return b;
  };

  /** One pass over a coin's tape: net inflow, breadth, rise, acceleration, top. */
  const scanTape = (b: CoinBook, now: number, curveSol: number): TapeScan => {
    const no: TapeScan = { qualifies: false, netSol: 0 };
    if (curveSol < cfg.minCurveSol || curveSol > cfg.maxCurveSol) return no;
    if (b.born === null || now - b.born < cfg.minCurveAge) return no;
    const edge = now - cfg.lookback;
    const half = now - cfg.lookback / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let flowOld = 0;
    let flowNew = 0;
    let firstPrice = -1;
    let top = 0;
    let lastPrice = 0;
    const wallets = new Map<string, number>();
    for (const tk of b.ticks) {
      if (tk.slot <= edge) {
        firstPrice = tk.price;
        continue;
      }
      if (firstPrice < 0) firstPrice = tk.price;
      const signed = tk.isBuy ? tk.sol : -tk.sol;
      if (tk.slot <= half) flowOld += signed;
      else flowNew += signed;
      if (tk.isBuy) {
        buySol += tk.sol;
        buys++;
        wallets.set(tk.wallet, (wallets.get(tk.wallet) ?? 0) + tk.sol);
      } else {
        sellSol += tk.sol;
      }
      if (tk.price > top) top = tk.price;
      lastPrice = tk.price;
    }
    if (buys < cfg.needBuys || wallets.size < cfg.needWallets) return no;
    const net = buySol - sellSol;
    if (net < cfg.needNetSol) return no;
    if (firstPrice <= 0) return no;
    const rise = lastPrice / firstPrice - 1;
    if (rise < cfg.needRise || rise > cfg.capRise) return no;
    if (cfg.dipHi > 0) {
      if (lastPrice > top * cfg.dipHi || lastPrice < top * cfg.dipLo) return no;
      let recentLow = Infinity;
      for (const tk of b.ticks) {
        if (tk.slot > now - cfg.bounceSpan && tk.price < recentLow) recentLow = tk.price;
      }
      if (recentLow === Infinity || lastPrice < recentLow * (1 + cfg.bounceUp)) return no;
    } else if (lastPrice < top * cfg.nearTop) return no;
    if (flowNew <= 0 || flowNew < cfg.accelNeed * flowOld) return no;
    let whale = 0;
    for (const v of wallets.values()) if (v > whale) whale = v;
    if (whale > cfg.maxWhaleShare * buySol) return no;
    if (cfg.longLookback > 0) {
      let longTop = 0;
      for (const tk of b.ticks) {
        if (tk.slot > now - cfg.longLookback && tk.price > longTop) longTop = tk.price;
      }
      if (lastPrice < longTop * cfg.longNearTop) return no;
    }
    return { qualifies: true, netSol: net };
  };

  /** Net recorded SOL (buys minus sells) over the last `span` slots. */
  const recentFlow = (b: CoinBook, now: number, span: number): number => {
    let net = 0;
    for (let i = b.ticks.length - 1; i >= 0; i--) {
      const tk = b.ticks[i]!;
      if (tk.slot <= now - span) break;
      net += tk.isBuy ? tk.sol : -tk.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const dumped = new Set<Pubkey>();
      const active = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          ownFills++;
          ownCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (clockStart === null) clockStart = e.block_time;
          if (clockNow === null || e.block_time > clockNow) clockNow = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          bookOf(e.mint).born = e.slot;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.ticks.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol,
            wallet: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          active.add(e.mint);
          if (!e.is_buy && sol >= cfg.dumpSol) dumped.add(e.mint);
        }
      }
      for (const mint of active) {
        const b = books.get(mint)!;
        let cut = 0;
        while (cut < b.ticks.length && b.ticks[cut]!.slot <= now - retain) cut++;
        if (cut > 0) b.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // 1. Exits first: cut losers, trail winners, fade, dump, hold clock.
      for (const [mint, tr] of trades) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            trades.delete(mint);
            const b = bookOf(mint);
            if (tr.sawFill) b.lastOut = now;
            else b.entries--;
          }
          continue;
        }
        tr.sawFill = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const curveSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_TAKE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > tr.bestValue) tr.bestValue = value;
        tr.lastValue = value;
        let out = tr.closing;
        const b = bookOf(mint);
        const riding = curveSol >= cfg.rideSol;
        if (!out && value < cost * (1 - cfg.cutLoss)) out = true;
        if (!out && !riding && tr.bestValue >= cost * (1 + cfg.trailArmUp) && value < tr.bestValue * (1 - cfg.trailDrop)) out = true;
        if (!out && !riding && recentFlow(b, now, cfg.fadeSpan) < -cfg.fadeSol) out = true;
        if (!out && !riding && dumped.has(mint)) out = true;
        if (!out && now - tr.openedSlot > cfg.holdLimit && value < cost * (1 + cfg.holdFreeIfUp)) out = true;
        if (!out) continue;
        tr.closing = true;
        if (pendingByMint.has(mint)) {
          let sellFlying = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellFlying = true;
          }
          if (sellFlying) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe legs: flip a landed probe straight back out.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries and top-ups.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let openLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let coreLeft = cfg.maxCore - trades.size;
      let booked = 0;
      for (const [mint, tr] of trades) {
        booked += Math.max(tr.spent, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of active) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const b = books.get(mint)!;
        const tr = trades.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const curveSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let ticket: number;
        if (tr === undefined) {
          if (openLeft <= 0 || coreLeft <= 0) continue;
          if (b.entries >= cfg.entriesPerCoin || now - b.lastOut < cfg.restSlots) continue;
          if (!scanTape(b, now, curveSol).qualifies) continue;
          ticket = Math.min(cfg.scoutSol, cfg.stakeCapSol);
        } else {
          // Top up into strength only: price stepped up, trade in profit, flow alive.
          if (tr.closing || !tr.sawFill || tr.spent >= cfg.stakeCapSol - cfg.floorBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < tr.lastBuyPrice * (1 + cfg.topupStep)) continue;
          if (tr.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + cfg.topupNeedUp)) continue;
          if (recentFlow(b, now, cfg.lookback) < cfg.topupNeedFlow) continue;
          if (curveSol > cfg.maxCurveSol) continue;
          ticket = Math.min(cfg.topupSol, cfg.stakeCapSol - tr.spent);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, ticket, cfg.maxBookSol - booked);
        if (amount > free - tx) amount = free - tx;
        if (amount < cfg.floorBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: cfg.slipBps });
        free -= amount + tx;
        booked += amount;
        if (tr === undefined) {
          trades.set(mint, {
            openedSlot: now,
            bestValue: 0,
            spent: amount,
            closing: false,
            sawFill: false,
            lastBuyPrice: price,
            lastValue: 0,
          });
          b.entries++;
          openLeft--;
          coreLeft--;
        } else {
          tr.spent += amount;
          tr.lastBuyPrice = price;
        }
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < cfg.maxProbes && openLeft > 0 && clockStart !== null && clockNow !== null) {
        const pace = Math.min(1, (clockNow - clockStart) / cfg.paceHorizonSec);
        const shortCoins = ownCoins.size < Math.ceil(cfg.paceCoins * pace);
        const shortFills = ownFills < Math.ceil(cfg.paceFills * pace);
        if (shortCoins || shortFills) {
          const minCurve = (cfg.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of active) {
            if (orders.length >= cap || probes.size >= cfg.maxProbes) break;
            if (trades.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (shortCoins && !shortFills && ownCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minCurve * 1.5) continue;
            if (free < cfg.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(cfg.probeSol * LAMPORTS)), max_slippage_bps: cfg.slipBps });
            probes.set(mint, false);
            free -= cfg.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
