# Landing + MCP page (bản người dùng duyệt 2026-11-16)

Chép từ canvas "DeskLabs landing hero" (https://claude.ai/artifact/TJb5NfGrcKwmNMDt1sFmB3, bản 1794818655-c6d8) để dev đọc trong repo mà không cần quyền mở canvas. Quyết định: DEC trong PR #166 (UI mới cho landing và trang MCP, mặc định theme sáng, có nút đổi theme; font Space Grotesk / Inter / JetBrains Mono).

Nếu canvas đổi sau ngày này, canvas thắng; nhờ DevOps chép lại.

| File | Nội dung | Phạm vi |
|---|---|---|
| `FullPage.dc.html` | Landing cả trang, mặc định sáng, nút đổi theme | **Code** |
| `FullPageLight.dc.html`, `FullPageDark.dc.html` | Landing cả trang ở từng theme | **Code** |
| `Main.dc.html` | Hero (tab Market Making / Volume Builder), component chính | **Code** |
| `HeroLight`, `HeroVolumeBuilder`, `HeroVolumeBuilderLight` | Hero ở từng theme / tab | **Code** |
| `Mobile.dc.html` | Hero ở 390 px | **Code** |
| `Proof.dc.html`, `ProofLight.dc.html` | Analytics theo chiến lược + Claude (MCP) | **Code** |
| `Sections.dc.html`, `SectionsLight.dc.html` | Strategies · How it works · Safety · Fees · FAQ | **Code** |
| `McpPage.dc.html`, `McpPageDark.dc.html` | Trang MCP `/claude`, mặc định sáng | **Code** |
| `canvas.json` | Bố cục canvas và ghi chú | Tham khảo |

Không chép: các artboard sign in / sign up / onboarding / app overview. Các màn này **giữ nguyên bố cục và theme sáng**, chỉ đổi font ở bước 2 (PR riêng).

Lưu ý khi code:
- `[totalVolume]`, `[botsLaunched]`: số thật lấy từ backend; không có thì ẩn ô hoặc hiện "Not available", không bịa số (CLAUDE.md 1.8).
- Log và biểu đồ Volume Builder là ví dụ, giữ nhãn "Example" / "Illustration".
- Bảng phí khớp DEC-258 (Market Making theo bậc) và DEC-266 (Volume Builder 0.005%).
- Câu chữ chép đúng từ file, đưa vào i18n (tiếng Anh).
