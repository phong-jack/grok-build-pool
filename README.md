# grok-pool — proxy pool cho Grok Build, giữ nguyên Thinking

Catch-all reverse proxy + account pool đặt giữa **Grok Build** (CLI `grok`) và `https://cli-chat-proxy.grok.com`.
CLI vẫn làm toàn bộ việc native (planning, tool calls, shell, filesystem, subagents, context, sessions) —
pool chỉ là **gateway thuần**: route, trace, và gom nhiều OAuth account lại để dùng chung 1 Grok Build.

**Và quan trọng nhất: thinking vẫn hiện.** (Chi tiết ở mục [Giữ thinking qua pool](#giữ-thinking-qua-pool).)

```
GROK BUILD ──> grok-pool :20129 ──┬──> account 01 ──┐
             (route / trace /     ├──> account 02 ──┼──> cli-chat-proxy.grok.com
              sticky / health)    └──> account N  ──┘
```

## Ai cần cái này?

- Bạn có **nhiều account Grok** (vd quản lý qua 9Router bằng device-code login) và muốn
  1 Grok Build dùng chung cả pool: hết slot account này tự chuyển account khác.
- Bạn muốn thấy **thinking** (reasoning summary) trong TUI — thứ mà upstream chỉ cấp cho **một số account**,
  không phải tất cả (xem [cơ chế](#vì-sao-thinking-biến-mất)).
- Bạn muốn nhìn thấy **mọi request** CLI gửi lên: endpoint nào, account nào phục vụ, latency, SSE events, lỗi gì —
  kèm dashboard realtime.

## Yêu cầu

- **Node.js >= 22.12** (dùng `node:sqlite` built-in, không cần build gì thêm)
- Grok Build CLI (`grok`) đã cài và đã login ít nhất 1 account
- (Tùy chọn) 9Router đang chạy và có account `grok-cli` — pool đọc account từ DB của 9Router

## Cài đặt & chạy

```powershell
git clone https://github.com/phong-jack/grok-build-pool.git
cd grok-build-pool
npm install
copy .env.example .env   # sửa ROUTER_DB_PATH nếu 9Router ở chỗ khác
npm start
```

Pool lên ở `http://127.0.0.1:20129` — dashboard: <http://127.0.0.1:20129/dashboard>.

## Trỏ Grok Build vào pool

**Cách 1 — env var (không đụng config):**

```powershell
$env:GROK_CLI_CHAT_PROXY_BASE_URL = "http://127.0.0.1:20129/v1"
grok
```

**Cách 2 — nếu file `~/.grok/config.toml` của bạn có `[model."..."]` tự định nghĩa `base_url`**
(thường trỏ vào 9Router): entry đó sẽ **ghi đè** env var. Sửa `base_url` của model đó thành
`http://127.0.0.1:20129/v1`, hoặc chạy Grok Build với `GROK_HOME` riêng chứa `auth.json` (copy từ
`~/.grok/auth.json`) nhưng **không** có `config.toml` — session lưu trong `GROK_HOME` đó nên
`grok --continue` phải chạy từ cùng thư mục đó.

Muốn quay về như cũ: đóng terminal (env var không lưu lâu dài) hoặc trả lại `base_url`.

## Account lấy từ đâu?

| Nguồn | Cách cấu hình | Ghi |
|---|---|---|
| **9Router** (mặc định) | `ROUTER_DB_PATH` trỏ vào SQLite của 9Router (vd `C:\Users\<bạn>\AppData\Roaming\9router\db\data.sqlite`) | Pool mở **read-only**, không bao giờ ghi — 9Router vẫn là chủ. Account `grok-cli` trong đó tự vào pool |
| **File riêng** | `data/accounts.extra.json` (xem format bên dưới) | Dành cho account ngoài 9Router — vd account "thinking" của bạn |
| **Login thêm** | `npm run login -- <tên>` — chạy `grok login` thật trong GROK_HOME riêng rồi tự import vào 9Router DB | Cần tương tác browser/device flow |

`data/accounts.extra.json`:

```json
[
  {
    "email": "ban@gmail.com",
    "userId": "user-uuid-từ-auth.json",
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "expiresAt": "2026-09-06T15:57:05Z",
    "premium": true
  }
]
```

Lấy 4 field đầu từ `~/.grok/auth.json` (key `https://auth.x.ai::...`): `key` → `accessToken`,
`refresh_token` → `refreshToken`, `user_id` → `userId`. Token hết hạn pool **tự refresh** (OIDC
`auth.x.ai`, giữ account sống vô hạn khi có refresh token) — bạn không phải làm gì thêm.

## Giữ thinking qua pool

**Phát hiện quan trọng:** upstream chỉ stream **reasoning summary** (cái làm nên block "Thought for Xs"
trong TUI) cho **một số account nhất định** — xét theo lý lịch account phía server, **không** liên quan
tới tier hiển thị trong `/v1/user` (luôn null), không liên quan model (grok-4.5/4.6 đều vậy), và không
liên quan pool (gọi thẳng không qua pool cũng y nguyên). Account mới tạo/còn "sạch" thường có summaries;
account bị dùng automation nhiều thường bị tắt.

Vì vậy pool có strategy **`premium-first`**:

1. Đánh dấu account nào có thinking: thêm `"premium": true` trong `data/accounts.extra.json`.
2. Set trong `.env`:
   ```
   POOL_STRATEGY=premium-first
   ```
3. Kết quả: **mọi inference ưu tiên đi qua account premium** → thinking luôn hiện. Khi premium bị
   429/cooldown/lỗi → request tự failover xuống xoay các account còn lại (hội thoại **không gãy** —
   `encrypted_content` của reasoning không khóa theo account, đã test thực tế). Premium hồi → tự gánh lại.

Lưu ý vật lý: turn phục vụ bởi account thường sẽ không có thinking text (mọi thứ khác vẫn bình thường).
Muốn thinking 100% + chia tải sâu hơn thì thêm **nhiều** account premium vào file — pool sẽ xoay vòng
giữa các premium trước, rồi tới nhóm dự phòng.

## Vì sao thinking "biến mất"?

(Điều tra từ source Rust công khai của Grok Build + wire-capture thật.)

- Thinking text chỉ render từ SSE events `response.reasoning_summary_text.delta` — upstream quyết định
  gửi hay không, theo account.
- `/v1/user` luôn trả `subscriptionTier: null` → CLI coi là Free và chèn banner
  `[Click here to Upgrade]` (tip do server inject, ai cũng thấy). Pool vá **đúng 1 field** này
  (`GROK_POOL_SUBSCRIPTION_TIER=SuperGrok`, tắt bằng giá trị rỗng) — ngoài ra không sửa gì khác.

## Tính năng

- **Catch-all**: mọi method/path/query đều forward — không whitelist, endpoint mới của CLI tự chạy
- **Protocol preservation**: body raw bytes, SSE pipe byte-exact, headers 2 chiều (lọc hop-by-hop),
  không auto-decompress — Grok Build không biết mình đang đi qua pool
- **Routing**: `premium-first` | `round-robin` | `least-used` | `random`; sticky theo
  `previous_response_id` + session UUID (failover giữa chừng không vỡ hội thoại)
- **Health**: ACTIVE / COOLDOWN / RATE_LIMITED (theo Retry-After) / DEGRADED / DEAD / AUTH_FAILED;
  403 chỉ cooldown ngắn (thường là lỗi theo-request, không phải chết account); prober định kỳ hồi sinh
- **Token refresh tự động** (OIDC discovery `auth.x.ai`), refresh token lưu override trong pool DB —
  9Router DB giữ read-only
- **Trace**: `GROK_TRACE=info|debug|wire` — ndjson có cấu trúc + wire dump per-request, redact token/cookie
- **Dashboard** realtime: trạng thái từng account, request inspector (status/latency/attempts/error)
- **Admin API**: `GET /pool/health|accounts|requests|stats|config`, `POST /pool/config` (đổi trace level live)

## Kiểm tra

```powershell
npm test          # golden tests: passthrough byte-identical, sticky, failover, no-retry-400... (node --test)
npm run smoke     # kiểm tra pool đang chạy (thêm --upstream để bắn 1 request thật)
```

## Câu hỏi thường gặp

**Pool có làm chậm / hỏng gì không?** Không — body đi nguyên bản, stream pipe thẳng, chỉ thêm vài ms
ở local. Failover chỉ xảy ra trước byte đầu tiên nên SSE không bao giờ bị chen ngang.

**Tôi không dùng 9Router?** Bỏ `ROUTER_DB_PATH` trỏ DB — pool lên với 0 account từ 9Router, dùng
hoàn toàn bằng `data/accounts.extra.json`.

**Token sống bao lâu?** Access token ~6h, nhưng pool tự refresh bằng refresh_token — account có
refresh token là sống vô hạn theo nghĩa vận hành.

**Cảnh báo**: đây là công cụ cho **account của chính bạn**. Đừng share token/file account cho ai,
và tự cân nhắc với điều khoản dịch vụ của xAI khi dùng nhiều account.

## License

Apache-2.0 (theo source Grok Build tham khảo)
