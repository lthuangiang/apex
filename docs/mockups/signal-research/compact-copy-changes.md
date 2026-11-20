# Signal research bản gọn: thay đổi câu chữ (chờ PM duyệt)

Câu cũ lấy từ `apps/web/messages/en.json` (khoá `signalAnalysis.research.*`) và ảnh UI thật lúc 06:46. Câu chữ UI giữ tiếng Anh. `{…}` là biến.

Quy ước mới đề xuất: trên UI, **"classifier" đổi thành "Claude reader"**, **"gate" đổi thành "counting"** hoặc "verdict". Tên trong code và DB giữ nguyên.

## 1. Câu đổi (cũ → mới)

### Dòng Progress và dải tóm tắt

| Khoá cũ | Câu cũ | Câu mới |
|---|---|---|
| `page.progress.label` | Progress | (bỏ, dải tóm tắt thay thế) |
| `page.progress.closed` | {n} of ~{gate} closed trades | Counting: {n} of ~{gate} closed trades · {weeks} (gắn vào dòng của từng version) |
| `judge.weeksToGo` | ~{weeks} to go | ~{weeks} weeks (đứng sau "Counting: …") / thiếu dữ liệu: time left Not available |
| `page.progress.labels` / `labelsNoPct` | Classifier {name}: {n} of {min} labels · {pct}% right | Chưa đủ nhãn: **Not counting yet:** label {more} signals to check Claude ({n} done) · Đủ nhãn và đạt: **Claude check passed:** {min} labels, {pct}% right · trades now count |
| `page.progress.context` | Context: collecting | Context: still collecting answers · see Is it working? |
| `page.progress.open` | {n} open trades | {n} open (trên dòng version) |
| `versions.showing` | Summary, news feed and trades below show **{name}**. | · shown below (nhãn nhỏ trên dòng version đang chọn) |

### Thẻ version và khu Bots & labels

| Khoá cũ | Câu cũ | Câu mới |
|---|---|---|
| `bots.title` / `labeling.title` | Paper bots / Classifier quality | Bots & labels (khu gập) → bên trong: Bot versions / Is Claude reading news right? |
| `versions.running` | **Running {n} of {max}** · at most {max} versions run at once | **{n} of {max} slots in use** |
| `versions.classifier` | Classifier **{name}** · precision {pct} on {n} labels | Claude reader {v} · share right {pct} ({n} labels) / chưa có nhãn: share right Not available (no labels yet) |
| `versions.labelMore` | Label more | Label signals |
| `versions.savedBaseline` | Saved {date}, {time} · locked, the reference for later versions | Saved {date}, {time} · can’t be changed · later versions are compared to it |
| `versions.summary.size` | {size} USDC | {size} USDC a trade |
| `versions.summary.tp` / `sl` | TP {x}× / SL {x}× | take profit {x}× / stop loss {x}× |
| `versions.summary.classifierNow` | now on classifier {v} | uses Claude reader {v} |
| `versions.count` | Count for the gate | Counting |
| (giá trị dưới `versions.count`) | 0 | Not yet · label {k} signals first (khi reader chưa đủ nhãn) |
| `versions.openLine` | **Open {open} / {max}** · today {today} / {limit} · blocked by limit {blocked} | **{open} open** (max {max}) · {today} opened today ({limit}) · {blocked} skipped by the limits |
| `versions.noLimit` | no limit | no daily limit |
| `versions.line.oldWaits` + `line.newCount` | {n} trade not counted · classifier {v} waits for labels ({k} to go). Classifier {v2} started a new count on {date}, {time}; it waits for labels ({k} to go). | {n} closed trade isn’t counted: it came from Claude reader {v}, which still needs {k} labels. Since {date}, {time} Claude reader {v2} is used, and it needs {k} labels too. |
| `versions.line.oldUnder` | {n} trades not counted · classifier {v} under 80%. | {n} closed trades aren’t counted: Claude reader {v} was right less than 80% of the time. |
| `versions.line.waits` | Trades count once classifier {v} has {min} labels at {pct}% or better ({k} to go). | Trades count once Claude reader {v} has {min} labels with {pct}% or more right ({k} to go). |
| `versions.line.under` | Not counted · classifier {v} under 80% · {n} labels. | Not counting: Claude reader {v} was right less than 80% of the time ({n} labels). |
| `versions.cols.classifier` | Classifier | Claude reader |
| `versions.cols.blocked` | Blocked by limit | Skipped by limits |
| `versions.cols.gate` | Gate | Counting? |
| `versions.closedCounted` | {closed} · {counted} counted | {closed} closed · {counted} counted |
| `versions.gate.notCountedWaits` | Not counted · classifier {v} waits for labels ({n} to go) | Not yet · label {n} signals first |
| `versions.gate.notCountedUnder(N)` | Not counted · classifier {v} under 80% (· {n} labels) | Not counting · Claude reader {v} under 80% right |
| `versions.gate.waits_for_labels` | Waits for labels | Waits for labels (giữ) |
| `bots.olderRules` | {n} trades from older rules ({versions}) still tracked below | {n} trades from older rules ({versions}) are still listed in Paper trades. |
| `labeling.cols.classifier` | Classifier | Claude reader |
| `labeling.cols.labels` | Labels | Labelled |
| `labeling.cols.right` | Right | Marked right |
| `labeling.cols.counts` | Trades count? | Counting trades? |
| `labeling.floor` | **The floor:** {min} labels with {pct}% or more right. | Trades count once a Claude reader has **{min} random labels** and at least **{pct}%** are marked right. |
| `labeling.mistakes` | Most common mistakes ({v}) | Most common mistakes (reader {v}) |

### Is it working?

| Khoá cũ | Câu cũ | Câu mới |
|---|---|---|
| `judge.closedTitle` | Closed trades for the gate | Closed trades counted |
| `judge.closedLine` (khi chưa đếm) | **0 / 100** · needs 100 more | **0 / 100** · not counting yet · label 50 signals first |
| `judge.labelsTitle` | Classifier {name} labels | Labels for Claude reader {name} |
| `judge.contextTitle` | Context (H1 whales) | Context: whales agree |
| `judge.contextNeeds` | each group needs {min} | {min} trades each |
| `judge.avgAt` | Average shows at {at} closed ({more} more); the gate needs {gate} | Shows after {at} closed trades ({more} more) · a verdict needs {gate} |
| `judge.randomAt` | Shown at {at} closed | Shows after {at} closed |
| `summary.sub` | Closed trades opened after the rules were fixed · cost of a trade ≈ {cost} (SoDEX taker fee and builder fee, in and out, plus spread) | Only trades opened after the rules were saved · each trade costs about {cost} (SoDEX taker and builder fee, in and out, plus spread) |

### From headline to trade

| Khoá cũ | Câu cũ | Câu mới |
|---|---|---|
| `…recordsOnly` (bước 4) | records only | saved, not used yet |
| `trace.unitNote` | Every step counts the same articles, collected in the {range}: in − out = next step. | Each step shows how many of the {range}’s articles are still in. |

### Drawer How it works

| Khoá cũ | Câu cũ | Câu mới |
|---|---|---|
| `page.drawer.tabs.gate` | The gate | When a signal passes |
| `page.drawer.classifierGate` | A trade counts only when the classifier that made it has **{min} labels** and is at least **{pct}% right**. | A trade counts only when the Claude reader that made it has **{min} labels** and at least **{pct}%** are marked right. |
| `versions.intro` (dời từ thân trang vào tab Versions) | Only the current classifier runs (one Claude read per article), and every running version trades on it. Each version has its own 10,000 USDC of fake money and its own gate. Trades count toward a gate only while the classifier that made them has passed its labels. | **One Claude read per article.** Claude reads each article once, with the current reader. Every running version trades on that same reading. / **Each version has its own money and its own count.** 10,000 USDC of fake money each. Up to 3 versions run at once. Trades count only while the Claude reader that made them has passed its labels. |
| `versions.allNote` (dời vào tab Versions) | Saved versions never change. A new classifier starts a new count for every running version. Every save, pause and stop is in the audit log with who did it. | **Saved versions never change.** To try other rules, copy a version and change a few rules. A new Claude reader starts a new count for every running version. Every save, pause and stop is in the audit log with who did it. |
| `labeling.intro` (dời vào tab Labels) | Measured per classifier version, because every News bot version uses the same classifier. **Right** = of the articles Claude called a signal, the share a person marked right. Signals Claude missed are measured later. | **Why per Claude reader, not per bot.** Every News bot version uses the same Claude reader, so labels are counted per reader version (v1, v2, v3). / **Marked right** = of the articles Claude called a signal, the share a person marked right. Articles Claude missed are checked later. |
| `labeling.randomOnly` + `labeling.randomNote` (dời vào tab Labels) | Only labels from **Label a random signal** count toward Labels, Right and the floor. Labels saved from a trace show as “from traces” and still count in the mistakes. / Picks at random from articles the current classifier called a signal, so the share isn’t skewed by which ones people choose. | **Which labels count.** Only labels from **Label signals** count toward the 50. It picks articles at random, so the share isn’t skewed by which ones people choose. Labels saved while tracing an article show as “from traces” and still count in Most common mistakes. |
| `labeling.floorRange` (dời vào tab Labels) | **The floor:** {min} labels with {pct}% or more right. With {n} labels at {p}%, the real share could be anywhere from about {lo}% to {hi}%, so this is a minimum, not proof. | **When trades start counting.** A trade counts only when the Claude reader that made it has {min} labels and at least {pct}% are marked right. With few labels the real share could be well above or below what you see, so this is a minimum, not proof. (Khi có số: giữ nguyên câu "from about {lo}% to {hi}%".) |

## 2. Câu mới hoàn toàn

| Chỗ | Câu |
|---|---|
| Dải tóm tắt, dòng version | `News bot · {name} (v{n}) · {state} · Balance {balance} ({pnl} unrealized) · {open} open` |
| Dải tóm tắt, thiếu dữ liệu | `Balance Not available`, `Open trades Not available`, `Counting: Not available`, `time left Not available` |
| Dải tóm tắt, nút | `Label signals`, `Manage versions` (mở và cuộn tới Bots & labels) |
| Dải tóm tắt, hàng nhãn | `Not counting yet: label {more} signals to check Claude ({n} done)` / `Claude check passed: {min} labels, {pct}% right · trades now count` |
| Khu gập, tiêu đề | `Bots & labels` |
| Khu gập, dòng phụ | `{n} of {max} slots in use · {tried} version(s) tried · Claude reader {v}: {n} of {min} labels` |
| Khu gập, nút | `Show` / `Hide` |
| Khu gập, tiêu đề con | `Bot versions`, `Is Claude reading news right?` |
| Khu gập, cuối | `Why labels and versions work this way: How it works › Versions · How it works › Labels` |
| Drawer, tab mới | `Labels` |
| Drawer › Labels | `What a label is. A person reads an article Claude called a signal and marks Claude’s reading Right or Wrong. The trade result stays hidden until you save, so it can’t sway the label.` |
| Drawer › Labels, ô cuối | `Claude reader {v} (current)` · `{n} of {min} labels · marked right {pct}` + nút `Label signals` |

## 3. Bỏ khỏi thân trang, không dời đi đâu

- `versions.showing` "Summary, news feed and trades below show …": dải tóm tắt và nhãn "shown below" đã thay câu này.

## 4. Chốt thêm khi code (PM, 2026-11-20)

- Chỉ một tên nút: `Label signals` (thay cả `Label a random signal`).
- Claude reader dưới 80%: `Not counting yet: Claude reader is right {pct}% of the time on {n} labels; it needs 80% on 50. Label more signals.` (nền amber nhạt).
- `versions.line.newCount` đứng được một mình nên bỏ chữ "too": `Since {date}, {time} Claude reader {v} is used; it needs {k} labels.`
- `versions.summary.classifier` và `classifierNow` cùng là `uses Claude reader {v}`.
- Thêm các câu còn chữ "gate" / "classifier" chưa có trong bảng: `extraCheck` (… so one can get a good verdict by luck …), `summary.needs.passed` (`Passed all checks.`), `contextHelp.slow` (`Slower than the main verdict.`), `drawer.gate` (`… only after it passes these checks: …`), `labeling.table`, `labeling.none`, `labeling.error`, `labeling.empty`, `labeling.notSignal`, `labeling.remaining`, `labeling.meta` (`Claude reader {v} · {cost}`), `versions.sheet.countNote` (`Claude’s reading instructions are the same for every version …`).
- `judge.closedLine` khi chưa đếm: `{n} / {gate} · not counting yet · label {k} signals first` (hoặc `· Claude reader under 80% right`), chỉ khi Claude reader chưa qua và chưa có lệnh nào được tính.
- Ô "Counting" của thẻ version khi reader dưới 80%: `Not yet · Claude reader under 80% right`.
