# Trading Agent · vị thế và thời gian giữ (#527)

Bản phác người dùng duyệt ngày 25/11 (issue #527), dựng lại tĩnh.

| File | Nội dung |
|---|---|
| `states.html` | Mọi trạng thái của hai ô: Open orders (chờ vào, Long, Short, không có giá, không có vị thế, bot nhiều sổ) và Last decision của Volume Builder (chưa khớp, đang đếm ngược, hết giờ giữ, không hiện) |
| `agent-position-1440.png`, `agent-position-390.png` | Ảnh bản code (layout test `agent-position.layout.ts`, `AGENT_SHOTS`) |

Màu chỉ là minh hoạ; code dùng design token (`text-pos`, `text-neg`, `text-accent-ink`, `text-warn`).
