// TidyOwl — momentum paper-trader for the make.fun "Winner Takes All — $5
// Pump.fun Replay Sprint" (agent-fun/replay/v2). The grader runs
// `node /bot/main.ts`; the strategy lives in owl.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { makeOwlBot, OWL_DEFAULT } from './owl.ts';

await runBot(makeOwlBot(OWL_DEFAULT));
