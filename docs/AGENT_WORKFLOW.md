# Quy trình làm việc cho agent code (branch → PR → review → merge)

Áp dụng cho mọi agent viết code trong repo này (Copy Trading, AI Desk B+, MCP, Notifications…). Mục đích: `main` luôn chạy được, mỗi thay đổi đều được review trước khi vào `main`, và các agent chạy song song không ghi đè việc của nhau.

**Vai trò**
- **Dev agent** (session "DeskLabs - DevOps"): code trên branch riêng, push, mở Pull Request.
- **Reviewer / PM** (session "DeskLabs - PM"): review PR, yêu cầu sửa, nhận câu hỏi cần chốt và đề xuất cho người dùng, báo kết quả.
- **Người dùng:** duyệt các câu cần chốt và quyết định merge. Chỉ merge khi reviewer đã đồng ý **và** người dùng nói "merge".

Hai session chạy trên cùng máy và nhắn nhau bằng `SendMessage` (`ListAgents` để thấy nhau).

---

## 1. Luật cứng

1. **Không bao giờ commit hay push thẳng lên `main`.** Không `git push --force` lên `main`. Không tự merge PR của mình.
2. Mỗi việc một branch, mỗi branch một PR. Không gộp hai tính năng vào một PR.
3. **Không commit secret:** `.env`, token, private key, seed, API key. Trước khi push, chạy bước quét ở mục 3.4.
4. Không chạy `prettier --write` hay `pnpm format` cho **toàn repo**. Chỉ format file mình sửa.
5. Không sửa file thuộc phạm vi của agent khác đang chạy (xem mục 5). Nếu bắt buộc phải sửa file dùng chung thì ghi rõ trong PR.
6. Không tự đổi DEC đã có. DEC mới ghi theo mục 4.
7. Báo kết quả test trung thực. Test fail thì dán output vào PR.

---

## 2. Bắt đầu một việc

```bash
git fetch origin
```

```bash
git switch -c feat/ai-desk-bplus origin/main
```

Nếu agent dùng chung máy với agent khác, nên dùng worktree riêng để không giẫm lên thư mục làm việc của nhau:

```bash
git worktree add ../drift-ai-desk -b feat/ai-desk-bplus origin/main
```

**Tên branch:** `<loại>/<phạm-vi>-<mô-tả-ngắn>`. Loại là một trong `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

Ví dụ: `feat/ai-desk-bplus`, `feat/mcp-oauth`, `feat/telegram-notify`, `fix/copy-start-duplicate-bot`.

---

## 3. Trong lúc code

### 3.1 Commit
- Dùng Conventional Commits, mỗi commit một ý: `feat(desk): add needs-you rules`, `fix(copy): reuse draft bot on failed start`.
- Commit nhỏ và thường xuyên.
- Cuối message thêm dòng attribution theo quy định của phiên đang chạy.

### 3.2 Giữ branch mới theo `main`
- Trước khi mở PR, và mỗi khi `main` có commit mới đụng tới phần mình làm:

```bash
git fetch origin && git rebase origin/main
```

- Có conflict thì tự giải. Không giải được thì dừng lại và hỏi.
- Đã push rồi mới rebase thì chỉ dùng `git push --force-with-lease`, và chỉ trên **branch của mình**.

### 3.3 Migration Drizzle
- Số migration có thể trùng với agent khác. Sau khi rebase, nếu `packages/db/src/migrations` bị trùng số, xoá migration của mình và sinh lại từ schema.
- Không bao giờ sửa migration đã có trên `main`.

### 3.4 Trước khi push

```bash
pnpm lint && pnpm typecheck && pnpm test
```

```bash
git diff origin/main --name-only | grep -E '(^|/)\.env$' && echo "STOP: .env is staged"
```

```bash
git diff origin/main | grep -nE '[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|sk-ant-|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{30,}'
```

Lệnh quét cuối phải không in ra gì. Nếu phần mình làm có E2E thì chạy thêm `pnpm e2e` cho spec liên quan.

---

## 4. DEC khi làm song song

- Số DEC hay bị trùng giữa các agent, nên trên branch **không dùng số**. Ghi DEC mới dạng `| DEC-TBD-<slug> | <ngày> | … |`, ví dụ `DEC-TBD-desk-facts`.
- Reviewer gán số thật lúc merge, rồi sửa các chỗ tham chiếu trong cùng PR.

### 4.1 Câu hỏi cần chốt (dev agent → PM → người dùng)

Dev agent **không hỏi thẳng người dùng**. Mọi chỗ cần chốt gửi cho PM: tài liệu không nói, mục **[confirm]**, đổi một DEC, thêm dependency ngoài ARCHITECTURE mục 4, đụng tiền thật hay quyền key, hai tài liệu mâu thuẫn, ngưỡng nghiệp vụ phải tự đặt.

Mỗi câu một tin (`SendMessage` tới "DeskLabs - PM"), câu không gấp thì gom lại:

```text
CẦN CHỐT · <tiêu đề ngắn> · PR/branch <…>
Bối cảnh: chuyện gì, file:line, tài liệu/DEC liên quan.
Phương án: A / B / (C), mỗi cái 1–2 dòng kèm hệ quả.
Đề xuất của bạn: <A/B> vì <…>.
Chặn việc không: Có (đang dừng) / Không (đang làm tạm theo phương án an toàn nhất: <…>).
```

PM làm:
1. Đối chiếu `CLAUDE.md`, `docs/`, DEC liên quan. Tài liệu đã trả lời thì nhắn lại ngay, không hỏi người dùng.
2. Còn lại thì đưa người dùng từng câu: phương án, khuyến nghị đặt đầu, lý do ngắn.
3. Người dùng chọn xong: nhắn dev agent `ĐÃ CHỐT · <tiêu đề> · <phương án>` kèm nội dung `DEC-TBD-<slug>` cần ghi trên branch.

Dev agent chỉ làm theo câu trả lời có chữ **"ĐÃ CHỐT"** từ PM. Câu không chặn việc thì vẫn làm tiếp theo phương án an toàn nhất và ghi rõ trong PR cho tới khi có câu trả lời.

---

## 5. Phạm vi file khi chạy song song

| Việc | Thư mục chính | Ghi chú |
|---|---|---|
| Copy Trading | `apps/*/copy*`, `apps/marketdata/src/{leaders,hl-leaders,leader-store,copy-allocator}.ts`, `apps/scheduler/src/leaderboard.ts`, `packages/hyperliquid`, `packages/shared/src/leader*`, `packages/strategies/src/copy-trade` | |
| AI Desk B+ | `apps/api/src/modules/desk`, `apps/web/src/features/desk`, `apps/reco` | |
| MCP | `apps/mcp`, `apps/api/src/modules/oauth` | |
| Notifications | `apps/jobs/src/notify*`, `apps/api/src/modules/telegram` | |
| **File dùng chung** | `apps/web/messages/en.json`, `apps/web/src/components/workspace-shell.tsx`, `packages/shared/src/api/*`, `packages/db/src/schema.ts`, `docs/DECISIONS.md` | được sửa, nhưng chỉ **thêm**, không sắp xếp lại hay format lại cả file; ghi rõ trong PR |

---

## 6. Mở Pull Request

```bash
git push -u origin feat/ai-desk-bplus
```

```bash
gh pr create --base main --title "feat(desk): AI Desk B+ M1–M3" --body-file pr-body.md
```

**Nội dung PR** (viết bằng tiếng Việt):

```markdown
## Làm gì
- Mốc / việc đã làm, file chính.

## Kiểm tra
- Lệnh đã chạy và kết quả thật (pass / fail kèm output).
- Chưa chạy gì, vì sao.

## Lựa chọn tự đưa ra
- Điểm tài liệu không nói, đã chọn gì; DEC-TBD-… nếu có.

## UI
- Ảnh chụp 1440 và 390 của màn đã đổi (nếu có).

## File dùng chung đã sửa
- en.json: thêm khoá `desk.*` …

## Rủi ro / việc còn lại
```

Sau khi mở PR, agent báo cho người dùng link PR và **dừng lại chờ review**. Không mở PR tiếp theo chồng lên PR đang chờ, trừ khi người dùng bảo.

---

## 7. Review (reviewer làm)

1. Đọc PR và diff:

```bash
gh pr view <số> && gh pr diff <số>
```

2. Chạy lint, typecheck, test của phần liên quan trên branch của PR. Nếu dev agent đã có worktree cho branch đó thì chạy test ngay trong worktree ấy nhưng **không sửa, không checkout, không xoá file nào** ở đó; cần sửa thử thì tạo worktree riêng. Có UI thì mở màn đó trên localhost và so với artboard.
3. Kiểm tra theo `CLAUDE.md` mục 1, `docs/CODING_STANDARDS.md` mục 14, DEC liên quan, và mục 1 của file này.
4. Ghi kết quả vào PR bằng **comment**:

```bash
gh pr comment <số> --body-file review.md
```

   Dòng đầu tiên của comment là kết luận, một trong hai:
   - `## Review: Cần sửa`, rồi mục "Phải sửa" (mỗi lỗi có `file:line`, vì sao sai, cách sửa) và mục "Nên sửa" (không chặn merge).
   - `## Review: Đạt`, kèm lệnh đã chạy và kết quả.

   Không dùng `gh pr review --approve` / `--request-changes`: dev agent và reviewer đang dùng chung một tài khoản GitHub, mà GitHub không cho tài khoản tự review PR của chính mình. Khi mỗi bên có tài khoản riêng thì dùng lại `gh pr review`.
5. Báo cho người dùng: đạt hay chưa, lỗi chính là gì, và đưa câu nhắn cho dev agent.

**Khi bị yêu cầu sửa:** dev agent sửa trên **cùng branch**, push thêm commit (không mở PR mới), rồi trả lời từng ý bằng comment trên PR. Reviewer xem lại phần đã sửa và đăng comment kết luận mới.

---

## 8. Merge (chỉ khi người dùng nói "merge")

```bash
gh pr merge <số> --squash --delete-branch
```

- Dùng **squash**: mỗi PR thành một commit trên `main`. Message là tiêu đề PR.
- Trước khi merge, reviewer gán số DEC thật (mục 4) và kiểm tra branch đã rebase theo `main` mới nhất.
- Sau khi merge, các agent khác đang chạy phải rebase branch của mình theo `origin/main`.

---

## 9. Khuyến nghị cài đặt trên GitHub (người dùng tự bật)

Vào repo › Settings › Branches › Add rule cho `main`:
- Require a pull request before merging.
- Block force pushes.

Có CI rồi thì bật thêm "Require status checks".
