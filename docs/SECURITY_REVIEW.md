# DRIFT — Rà soát bảo mật (P11, 2026-10-28)

> Đối chiếu checklist `docs/CODING_STANDARDS.md` mục C12 và quy tắc sản phẩm `CLAUDE.md` mục 1. Mỗi dòng ghi bằng chứng (code / test). Mục chưa đạt ghi rõ.

## C12

| Yêu cầu | Trạng thái | Bằng chứng |
|---|---|---|
| Secret từ env / Vault, không commit `.env` | Đạt | `.env` không nằm trong repo (`.gitignore`); private key API chỉ ở Vault transit, chỉ `signer` giải mã (`apps/signer`) |
| Cookie phiên `httpOnly`, `Secure`, `SameSite=Lax`; CSRF cho request ghi | Đạt | `apps/api/src/plugins/session.ts` (double-submit `drift_csrf` + `X-CSRF-Token`); test `apps/api/test/auth.test.ts` |
| 2FA ở server cho start bot, stop bot, revoke fee, disconnect, xoá tài khoản | Đạt | `verifyTwoFactor` trong `bots/service.ts` (start/stop), `sodex/service.ts` (revoke, disconnect), `profile/routes.ts` (xoá tài khoản); thêm Emergency halt. Test: `bots.test.ts`, `sodex-connect.test.ts`, `profile.test.ts`, `account.test.ts` |
| Rate limit API theo user và IP | Đạt | `apps/api/src/plugins/rate-limit.ts` (Redis, cửa sổ 1 phút: 600/IP, 300/user) + giới hạn OTP riêng; test `rate-limit.test.ts` |
| CSP chặt, không `unsafe-inline` cho script | Đạt | `apps/web/src/proxy.ts` (nonce mỗi request, `strict-dynamic`, `frame-ancestors 'none'`); E2E `p11-a11y.spec.ts` kiểm tra header. Style còn `unsafe-inline` (C12 chỉ cấm cho script) |
| Kiểm tra quyền sở hữu ở mọi endpoint; Builder Revenue chỉ role `team` | Đạt | Mọi truy vấn lọc theo `userId` của phiên (48 route dùng `requireAuth`); test 404 khi truy cập dữ liệu người khác (`reco.test.ts`, `backtests.test.ts`); `builderRevenue` trả `FORBIDDEN` (`account.test.ts`, E2E `p10-screens.spec.ts`) |

## Quy tắc sản phẩm liên quan

| Quy tắc | Trạng thái | Bằng chứng |
|---|---|---|
| 1.1 Không rút / chuyển tiền | Đạt | Không có endpoint / action rút hay chuyển; key tạo bằng `UserSignedAddPermissionedAPIKeyAction` mặt nạ 14 (WITHDRAW, TRANSFER tắt) — **còn phải kiểm chứng tay trên mainnet** trước khi bật `SODEX_CONNECT_ENABLED` |
| 1.7 Không retry mù | Đạt | Lệnh ghi trước `unknown`, đối soát rồi mới quyết định; E2E `p11-safety.spec.ts` (timeout sau khi SoDEX nhận → đối soát, không gửi lại) |
| 1.9 Không lộ secret | Đạt | Redact log (`REDACT_PATHS` trong api, signer); key chỉ hiện `••last4`; idempotency không lưu response nhạy cảm (DEC-29) |
| Tách quyền ký (DEC-42) | Đạt | mTLS api/engine ↔ signer: client cert do CA nội bộ ký, CN `api` chỉ tạo key, CN `engine` chỉ ký lệnh; signer từ chối khởi động thiếu cert khi `SIGNER_REQUIRE_MTLS=true`; test `apps/signer/test/mtls.test.ts`, E2E chạy qua mTLS |
| Fencing engine | Đạt | Epoch shard kiểm tra ở DB và ở signer (DEC-37) |

## Chưa làm / cần người dùng quyết

- **Load test** theo mục tiêu ARCHITECTURE.md mục 3.5 (5.000 account, 20.000 bot, p95 < 300 ms) chưa chạy: các con số đang **[confirm]**. Đã đo: backtest 90 ngày nến 1m ≈ 12 s, dữ liệu thật 90D/15m ≈ 4.4 s (mục tiêu < 20 s).
- **Observability** (profile, metrics Prometheus): chưa thêm exporter; log JSON có `reqId`/`traceId`.
- Cert production phải cấp bằng PKI riêng; `infra/certs/gen-dev-certs.sh` chỉ cho dev / E2E.
- Rà soát pentest bên ngoài: chưa có.
