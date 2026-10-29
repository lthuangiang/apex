**Subject:** Request for written confirmation: post-only market-making bot ("Volume Maker") on SoDEX via Builder Codes

Hi SoDEX team,

I'm [Name], [role] at DRIFT ([website]). DRIFT is a trading-bot platform for SoDEX users. Users connect their own SoDEX account with one master-wallet signature (`AddAPIKeyWithBuilder`), and DRIFT sends orders with our builder code (builder ID [DRIFT_BUILDER_ID]). DRIFT never withdraws or transfers user funds.

We plan to offer an optional bot called **Volume Maker**. Before we release it, we would like your written confirmation that it complies with your rules, including the Layer 1 Season SoPoints program and its "zero tolerance for wash trading" policy.

**What the bot does**
- Places two-sided **post-only** quotes (`timeInForce = GTX`) on BTC-PERP and ETH-PERP at 1× leverage, close to the mid price. It refreshes every 2–60 seconds and keeps inventory near zero.
- It is **maker-only**. The only taker order is a single reduce-only close when the bot stops.
- Every order rests on the book as real, fillable liquidity until another trader fills it or the bot cancels it.

**Safeguards**
- **Self-trade prevention on our side**, because the API has no STP field. Before every place or replace, our engine checks all of the account's resting orders on that market, across all of the user's DRIFT bots. A new buy must be priced below the account's own lowest ask, and a sell above its own highest bid. Otherwise the order is not sent.
- **One writer per account.** Each SoDEX account is handled by exactly one DRIFT worker at a time, so there are no duplicate orders and no race conditions.
- **We do not**:
  - trade between accounts belonging to the same user;
  - coordinate quotes between different users;
  - randomise timing or sizes to avoid detection;
  - place orders without real resting liquidity.
- **User-set cost budget** (fees plus trading losses). The bot stops when the budget is used, and shows the user the live cost per $1M of volume.
- **Rate limits:** we stay within your published limits (20 orders/s, 600/min per key, and the address-based allowance) and slow down rather than burst.
- **No promises about points.** The UI states that SoDEX does not publish how volume converts to SoPoints and that points are not guaranteed.

**Our questions**
1. Is a bot like this allowed to take part in the Layer 1 Season and future SoDEX trading events, and is its volume counted like any other trading volume?
2. Could your risk engine flag an account just because it quotes regularly and automatically? If so, what patterns or limits should we stay within?
3. When users of the same platform (DRIFT) happen to fill each other's quotes, is that acceptable? Each user is a separate account with independent quotes and no coordination.
4. Are there market, size, refresh-rate or open-interest limits you would like us to apply for this type of bot?
5. Is there an official self-trade prevention option planned for the order API that we should use instead of our client-side check?
6. Do you have a market-maker or liquidity-provider program (for example SLP) that would suit this use better?

We are happy to share more technical details, run the bot on testnet first, or give you a way to identify DRIFT-originated orders for monitoring.

Thank you. We look forward to your reply.

Best regards,
[Name]
[Role], DRIFT
[Email] · [Telegram/Discord handle]
