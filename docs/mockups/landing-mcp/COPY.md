# Landing + MCP page: final copy (approved by user 16/11/2026)

Source of truth for layout: canvas https://claude.ai/artifact/TJb5NfGrcKwmNMDt1sFmB3. Local copies of every artboard sit next to this file, in `project/*.dc.html`.

- Landing = `FullPage.dc.html`. It imports `Main.dc.html` (hero), `Proof.dc.html` (Analytics + Claude) and `Sections.dc.html`.
- MCP page `/claude` = `McpPage.dc.html`.
- Phone hero = `Mobile.dc.html`.
- Theme: default LIGHT on both pages. A sun/moon button in the nav switches the theme and remembers it (localStorage, wrapped in try/catch).
- Fonts on both pages: Space Grotesk for headings, Inter for body, JetBrains Mono for numbers and labels. Logo unchanged (`icon.svg`).
- Out of scope for step 1: `Auth*`, `AppOverview`. Step 2 is fonts only, in a separate PR.

Legend:
- **NEW** = add a key.
- **CHANGED** = replace the existing value.
- **KEEP** = reuse the existing key as is.
- **DROP** = no longer shown.

Key names are suggestions under `landing.*`.

## Nav (landing)
| Status | Suggested key | English |
|---|---|---|
| KEEP | landing.nav.strategies | Strategies |
| CHANGED (now scrolls to #analytics) | landing.nav.lab | Analytics |
| KEEP | landing.nav.how / safety / fees / faq | How it works · Safety · Fees · FAQ |
| NEW | landing.nav.claude | Claude |
| DROP | landing.nav.desk | AI Desk & Copy |
| KEEP | landing.nav.signIn / createAccount | Sign in · Launch app |
| NEW | landing.nav.themeLight / themeDark (aria-label) | Switch to light · Switch to dark |

## Hero
| Status | Suggested key | English |
|---|---|---|
| CHANGED (replaces eyebrow pill) | landing.hero.status | On SoDEX mainnet · Powered by SoDEX Builder Code |
| CHANGED | landing.hero.title | Volume on SoDEX, built mostly with maker orders. |
| CHANGED | landing.hero.body | Market Making and Volume Builder trade on your own SoDEX account. Each bot logs why it acted, shows what every $1M of volume cost you, and stops at the loss limit you set. |
| KEEP | landing.nav.createAccount | Launch app |
| NEW (replaces "Explore strategies") | landing.hero.watch | Watch a bot work |
| NEW | landing.hero.promisesLabel (aria) | What DeskLabs can do on your account |
| NEW | landing.hero.withdrawLabel / withdrawValue | Withdraw or transfer · Never |
| NEW | landing.hero.seedLabel / seedValue | Seed phrase · Never asked |
| NEW | landing.hero.connectLabel / connectValue | Connect · Two signatures |
| DROP | landing.hero.promises.* (check-mark row) | — |

### Hero panel (tabs)
| Status | Suggested key | English |
|---|---|---|
| NEW | landing.hero.panelLabel (aria) / tabsLabel (aria) | Example bot · Strategy |
| KEEP | strategy names | Market Making · Volume Builder |
| KEEP | landing.strategies.feeRate | Builder fee {rate} |
| NEW | landing.hero.mm.sub | Sits in the book on both sides, no direction |
| KEEP | landing.hero.cardStatus | Running |
| KEEP + NEW | landing.hero.price / size · NEW side / ask / bid | Price · Size (USDC) · Side · Ask · Bid |
| KEEP | landing.hero.you / decisions | YOU · Decisions |
| CHANGED | landing.hero.dec1 / dec1Why | Ask requoted · best ask moved away, ask placed again at the new price |
| KEEP | landing.hero.dec2 / dec2Why | Filled · bid 0.0003 BTC, maker |
| NEW | landing.hero.mm.bothTitle / bothBody | Both sides · A bid and an ask, post-only, near the mid |
| NEW | landing.hero.mm.fillTitle / fillBody | After a fill · The closing quote moves closer, the other backs off |
| NEW | landing.hero.mm.capTitle / capBody | Cost cap · Stops at your limit; Smart quoting closes the position if price runs 15 bp against it |
| CHANGED | landing.hero.cardNote | Illustration. In the app you see your own bot, the live SoDEX book and your real numbers. |
| NEW | landing.hero.vb.sub | Reads a signal, then takes one short trade |
| NEW | landing.hero.vb.example | Example |
| NEW | landing.hero.vb.signalTitle / signalSource | 1 · Signal before entry · 1-min candles + order book |
| NEW | landing.hero.vb.short / long | Short · Long |
| NEW | landing.hero.vb.score / scoreWhy | Score {score} · above 0.5, so long |
| NEW | landing.hero.vb.trend / notAgainst / spreadOk | 5-min trend: {regime} · Not against the trend ✓ · Spread OK ✓ |
| NEW | landing.hero.vb.tradeTitle | 2 · One trade, protected on SoDEX |
| NEW | landing.hero.vb.chartBe / chartSl / chartIn / chartOut | Break-even trigger {price} · Stop loss on SoDEX {price} · Enter {price} · Exit {price} |
| NEW | landing.hero.vb.chartAria | Example round: long entry at 1,817.6, stop loss on SoDEX at 1,808.5, break-even trigger at 1,820.3, closed at 1,819.8 after 19 seconds |
| NEW | landing.hero.vb.s1 / s1Why | Enter long · Post-only at 1,817.6, so it fills as maker |
| NEW | landing.hero.vb.s2 / s2Why | Stop loss set on SoDEX · SoDEX closes the position at 1,808.5, even if DeskLabs is offline |
| NEW | landing.hero.vb.s3 / s3Why | Break-even · The stop moves to break-even once price reaches 1,820.3 |
| NEW | landing.hero.vb.s4 / s4Why | Closed long · Early profit: a gain bigger than a multiple of the fees you set |
| NEW | landing.hero.vb.volTitle / volBody | Volume · Both sides of every fill |
| NEW | landing.hero.vb.costTitle / costBody | Net cost / $1M · Net loss ÷ volume × 1,000,000 |
| NEW | landing.hero.vb.makerTitle / makerBody | Maker share · Of your volume |
| NEW | landing.hero.vb.note | Example round. In the app you see every round your bot makes, with its real volume and cost. |

The example values (score 0.583, SIDEWAY, 1,817.6 / 1,808.5 / 1,820.3 / 1,819.8, 19 s) come from one real prod round (DevOps OK: label "Example", no PnL or CPM).

### Stats strip
| Status | Suggested key | English |
|---|---|---|
| CHANGED | landing.stats.volume | Traded on SoDEX by DeskLabs bots, all time |
| KEEP | landing.stats.bots | Bots launched, all time |
| NEW | landing.stats.mmFee | Market Making builder fee, lower at volume |
| NEW | landing.stats.vbFee | Volume Builder builder fee |
| DROP | landing.stats.builtOn / sodex / strategies | — |

Values come from `/api/v1/public/stats` as today; show "—" while loading. Fees come from `builderFeeRateOf`.

## Analytics (new section, id `analytics`)
| Status | Suggested key | English |
|---|---|---|
| NEW | landing.analytics.label | In the app |
| NEW | landing.analytics.title | Each strategy gets the analytics it needs |
| NEW | landing.analytics.body | Market Making is judged by what happens after each quote fills. Volume Builder is judged trade by trade. Both are built from the bot’s real SoDEX fills. |
| KEEP (agent.mma.title) | — | Market Making Analytics |
| NEW | landing.analytics.example | Example · ETH-USD |
| KEEP (agent.mma.*) | — | Volume · Fill rate · Time on book · Maker share; subs "USDC", "{f} of {p} orders", "Median, order sent → filled" |
| NEW | landing.analytics.ofVolume | Of volume |
| KEEP (agent.mma.adverseTitle) | — | Adverse selection |
| NEW | landing.analytics.adverseSub | Fills the price went against, 1 min after |
| KEEP (agent.mma.allQuotes / side.*) | — | All quotes · Bid fills · Ask fills |
| NEW | landing.analytics.coinFlip | Line = 50%, a coin flip |
| KEEP (agent.mma.inventoryTitle / inventorySub) | — | Inventory · Max {max} USDC · flat {flat} of the time |
| NEW | landing.analytics.inventoryAria | Example inventory over 13 hours: mostly flat at zero, with short positions up to plus or minus 20 USDC |
| NEW | landing.analytics.insightLabel | Key insight · |
| KEEP (insight text from agent) | — | Bid fills are hit worse: 1.2 bp more adverse move than the other side after a minute. |
| NEW | landing.analytics.vbTitle | Volume Builder · Volume and analytics |
| KEEP (volume dashboard keys) | — | Volume generated · Both sides of every fill · Trading efficiency · Maker share of volume · Fill ratio · Trades / hour · In this period |
| NEW | landing.analytics.holdTitle / holdSub | Trades by holding time · Number of closed trades |
| KEEP (agent.sa buckets) | — | 0–30s · 30–60s · 1–2m · 2–5m · 5–10m · 10m+ |
| NEW | landing.analytics.holdAria | Example: 15 trades held 0 to 30 seconds, 14 held 30 to 60 seconds, 11 held 1 to 2 minutes, 17 held 2 to 5 minutes, 2 held 5 to 10 minutes, none longer. |
| NEW | landing.analytics.splitTitle / splitSub | Volume breakdown · Share of volume |
| KEEP | — | Buy · Sell · Maker · Taker |
| NEW | landing.analytics.reviewLabel / reviewBody | Review this run · replays the bot’s real entries with other exit settings, and suggests a change only when it wins on trades it was not tuned on. |
| NEW | landing.analytics.note | Examples from real DeskLabs bots. Your bot shows its own numbers. Not a forecast. |

The example numbers are static in the page; they come from real prod bots on 15/11. No fees per $1M, CPM, PnL or win rate are shown (DevOps condition).

## Claude section on the landing (id `claude`)
Reuse `claudeGuide.*` for every string: hero.eyebrow, hero.title, hero.body, hero.server, hero.copy / copied, hero.connect, hero.see, chat.*, try.prompts.p6, drafts.banner / bannerBody / bannerExpires.

The permission table (rows from `claudeGuide.permissions.*`) needs these new strings:

| Status | Suggested key | English |
|---|---|---|
| NEW | landing.claude.tableCaption | What Claude gets |
| NEW | landing.claude.neverRow | Trade, change bots or move money |
| KEEP | landing.safety.never | Never |

## Strategies (id `strategies`)
| Status | Suggested key | English |
|---|---|---|
| NEW | landing.sectionIndex (label pattern) | 01 · Strategies (02 · How it works, 03 · Safety, 04 · Fees, 05 · FAQ) |
| KEEP | landing.strategies.title / body | Two flagship strategies, {count} more ready to run · Defaults are tuned per market… |
| CHANGED | landing.strategies.mm.p1 | Smart quoting follows the live SoDEX book and the Binance price, and closes the position if price runs 15 bp against it |
| NEW (approved fee-tier design) | landing.strategies.mm.p4 | Builder fee drops to 0.002% and 0.001% as your volume grows |
| CHANGED (approved fee-tier design) | landing.strategies.feeRate on the MM card | Builder fee {rate}, lower at volume |
| KEEP | landing.strategies.mm.p2/p3, vf.*, beta, cta | — |
| NEW | landing.compare.title | How they differ |
| NEW | landing.compare.question (sr-only) | Question |
| NEW | landing.compare.otherCol | Other strategies |
| NEW | landing.compare.tradesQ / mm / vb / other | How it trades · Keeps a post-only bid and ask in the SoDEX book; requotes when the best price moves away · One position at a time, post-only inside the spread; market orders only if you turn them on · Grid levels, DCA steps, a schedule or target weights |
| NEW | landing.compare.directionQ / … | Picks a direction · No. Stays near flat and leans to close after a fill · Yes. Scores 1-minute candles and the order book, and skips trades against the 5-minute trend · You choose it: long, short, neutral or buy only |
| NEW | landing.compare.lengthQ / … | How long a trade lasts · No single trade. Quotes refresh every few seconds · Seconds to minutes, within the hold time you set · Hours to weeks, until a target or schedule |
| NEW | landing.compare.protectQ / … | What protects you · Stops at your cost cap; with Smart quoting, closes the position at market if price runs 15 bp against it · A stop loss on SoDEX itself, moved to break-even as price moves your way · Stop loss and limits per strategy |
| NEW | landing.compare.feeQ / … | Builder fee · 0.003%, lower at volume · 0.005% · 0.01% |
| KEEP | landing.strategies.more | More strategies |
| NEW | landing.strategies.colStrategy / colMarket / colWhat | Strategy · Market · What it does |
| KEEP | catalog names, markets and one-liners | (as today) |
| KEEP | landing.strategies.backtest | Backtest any setup on SoDEX price history before you start. A backtest is a simulation, not a forecast. |

## How it works / Safety
| Status | Suggested key | English |
|---|---|---|
| KEEP | landing.how.* | all |
| KEEP | landing.safety.* | all |
| NEW | landing.safety.tableCaption | What the app can do on your SoDEX account |

## Fees (approved fee-tier design, DEC-258 / DEC-266)
| Status | Suggested key | English |
|---|---|---|
| KEEP | landing.fees.title / body | Low builder fees, shown before you sign · Charged by SoDEX… |
| NEW | landing.fees.colStrategy / colVolume / colFee | Strategy · Your Market Making volume, last 30 days · Fee |
| NEW | landing.fees.tier1 / tier2 / tier3 | Under $200K · $200K to $1M · $1M and up |
| NEW | landing.fees.oneRate | One rate |
| NEW | landing.fees.tierNote | Market Making gets cheaper as you trade more. We check your last 30 days every hour, and new orders use the new rate right away. No new signature. |
| KEEP | landing.fees.mm / vf / other | Market Making · Volume Builder · Every other strategy |

Rates come from `FEE_TIERS` / `builderFeeRateOf`. Do not hardcode them.

## Also in the app (replaces the AI Desk & Copy cards)
| Status | Suggested key | English |
|---|---|---|
| NEW | landing.extras.title | Also in the app, on the same safety rules |
| KEEP | landing.desk.items.desk / copy / alerts (.title + .body only) | AI Desk … · Copy Trading … · Alerts on Telegram … |
| KEEP | landing.desk.note | Copying and AI suggestions are not financial advice. Past results are not a forecast. |
| DROP | landing.desk.eyebrow / title / body, item bullets, the claude card, landing.lab.* | — |

## FAQ, CTA, footer
KEEP everything: landing.faq.*, landing.cta.*, landing.footer.*. "Sign in" in the CTA reuses landing.nav.signIn.

## MCP page `/claude` (McpPage.dc.html)
- Copy: every string already exists in `claudeGuide.*`. **No new copy.** This is a new layout, new fonts, a theme toggle and default light.
- One change: `claudeGuide.connect.code.s1.body` says "on the right". In the new layout the terminal sits **below** the steps, so it reads "Run the command below in your terminal. …" (CHANGED).
- New nav strings: reuse `claudeGuide.nav.*` and `claudeGuide.launch`, plus the same theme toggle aria labels as the landing.
- Section order: Hero (server address + example chat) → What it does (4 numbered items + "What Claude can't do") → Connect (tabs: Claude app / Claude Code, 4 numbered steps, terminal under the steps for Claude Code, Good to know, consent preview) → Permissions → Try asking → How drafts work → Disconnect + Limits → Questions → Ready to connect → footer.
