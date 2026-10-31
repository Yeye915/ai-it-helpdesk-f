# HelpMate AI IT Helpdesk — bản kết hợp

Dự án gồm giao diện Next.js, API quản lý ticket, MongoDB và 9 workflow n8n.

## Yêu cầu
- Node.js 20.9+ (khuyến nghị bản LTS)
- npm
- MongoDB local hoặc MongoDB Atlas
- n8n chỉ cần khi muốn chạy tự động hóa ticket

## 1. Cài đặt
```bash
npm install
```

Tạo file `.env.local` ở thư mục gốc bằng cách sao chép `.env.example`, sau đó chỉnh `MONGODB_URI` thành URI MongoDB của bạn.

Ví dụ MongoDB chạy local:
```env
MONGODB_URI=mongodb://127.0.0.1:27017/it_helpdesk
N8N_WEBHOOK_URL=
```

Không đưa `.env.local` lên Git hoặc chia sẻ công khai.

## 2. Chạy website
```bash
npm run dev
```
Mở http://localhost:3000

## Đăng ký và đăng nhập

- `/register`: tạo tài khoản bằng họ tên, email, mật khẩu và xác nhận mật khẩu. Đăng ký thành công sẽ đăng nhập và mở trang chính.
- `/login`: đăng nhập bằng email và mật khẩu. Chưa đăng nhập sẽ được chuyển về trang này khi mở `/`.
- Nút đăng xuất nằm cạnh thông tin tài khoản trên thanh bên. Tên hiển thị được lấy từ tài khoản MongoDB.
- Mật khẩu dài 8–128 ký tự, được băm bằng scrypt và salt riêng. Phiên đăng nhập có hạn 7 ngày; cookie dùng HttpOnly, SameSite=Lax và Secure ở production. Database chỉ lưu bản băm của token phiên; đăng xuất thu hồi phiên trên server.
- Các endpoint `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout` và `GET /api/auth/me` xử lý tài khoản. Đăng nhập/đăng ký giới hạn 20 yêu cầu mỗi email trong mỗi khoảng 15 phút.
- API ticket và chat yêu cầu cookie phiên hợp lệ. Hiện các tài khoản cùng dùng không gian ticket chung; chưa phân quyền theo vai trò, xác minh email hoặc khôi phục mật khẩu. n8n gọi API nội bộ cũng cần xác thực; chưa có cơ chế service token riêng.

MongoDB phải hoạt động và `MONGODB_URI` phải được thiết lập trước khi khởi động. Có thể tạo `.env.local` với URI local ở phần cài đặt phía trên nếu chưa có file mẫu. Dùng HTTPS khi triển khai production để trình duyệt gửi cookie Secure.

Kiểm tra sau khi đã chạy ứng dụng và MongoDB local:

```bash
npm run lint
npm run build
node --env-file=.env.local --test tests/auth.test.mjs
```

Nếu đã cung cấp `MONGODB_URI` qua biến môi trường, có thể bỏ `--env-file=.env.local`. Bộ kiểm tra tích hợp dùng địa chỉ local (mặc định cổng 3000), tạo tài khoản ngẫu nhiên và tự dọn dữ liệu của lần kiểm tra; dùng `AUTH_TEST_BASE_URL` khi chạy ứng dụng ở cổng khác.

Kiểm tra lỗi prerender trên trình duyệt khi đã có MongoDB:

```bash
npx playwright install chromium
npm run test:auth:browser
```

Kiểm tra này dùng chế độ development, tự khởi động Next.js nếu cần và xác nhận trang đã đăng nhập không có lỗi console hoặc bảng lỗi Next.js khi mở trang hay tải lại. Nếu máy đã có Chromium, có thể đặt `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` để dùng trình duyệt đó.

## Tạo tài khoản bằng script seed

Script `scripts/seed-users.mjs` đọc `.env.local`. Cấu hình `MONGODB_URI`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEMO_USER_EMAIL` và `DEMO_USER_PASSWORD` trực tiếp trong file này. Có thể thêm `ADDITIONAL_USER_EMAIL`, `ADDITIONAL_USER_PASSWORD`, `ADDITIONAL_USER_NAME` cho một tài khoản bổ sung. Không commit các giá trị bí mật.

`MONGODB_DB` chọn database, mặc định là `it_helpdesk`; kết nối của ứng dụng cũng dùng lựa chọn này. Dùng cùng giá trị cho ứng dụng và script seed.

```bash
npm run seed:users
```

Lệnh tạo hoặc cập nhật tên, vai trò và mật khẩu của các email được cấu hình; chạy khi bạn muốn cập nhật các tài khoản đó. Mật khẩu được băm theo định dạng `scrypt$salt$hash`. Đăng nhập hỗ trợ cả định dạng này và định dạng `salt:hash` của tài khoản cũ. Đăng ký công khai luôn tạo vai trò `user`; script seed có thể tạo `admin`. Vai trò được hiển thị trên dashboard; các tài khoản vẫn cùng dùng không gian ticket chung, chưa có giới hạn API theo vai trò.

Giao diện dashboard từ file `page.tsx` được ghép tại `src/components/HelpdeskDashboard.tsx`; `src/app/page.tsx` giữ kiểm tra phiên phía server. Tên tài khoản và nút đăng xuất tiếp tục lấy theo phiên hiện tại.

Kiểm tra script và đăng nhập với tài khoản kiểm thử trên MongoDB local, khi ứng dụng đang chạy:

```bash
node --env-file=.env.local --test tests/auth.test.mjs tests/seed-users.test.mjs
```

## 3. Kết nối n8n (tùy chọn)
1. Mở n8n.
2. Import các file JSON trong `n8n-workflows/` (Import from File).
3. Cấu hình lần lượt các node HTTP Request trong từng workflow để gọi URL webhook của workflow kế tiếp. Kiểm tra credential/URL theo môi trường n8n của bạn.
4. Kích hoạt `WF01 - Ticket Intake`.
5. Sao chép **Production URL** của Webhook node trong WF01 và đặt vào `N8N_WEBHOOK_URL` trong `.env.local`.
6. Khởi động lại Next.js sau khi thay đổi biến môi trường.

Các workflow hiện được xuất ở trạng thái chưa kích hoạt. Hãy kiểm tra URL nối giữa các workflow và thử bằng dữ liệu giả trước khi dùng thật; import workflow không tự động cấu hình credential hoặc tự kích hoạt chúng.

## Các workflow đi kèm
- WF01 — Ticket Intake
- WF02 — Ticket Classification
- WF03 — Priority Assessment
- WF04 — Team Assignment
- WF05 — Duplicate Detection
- WF06 — Support Response
- WF07 — High Priority Alert
- WF08 — SLA Monitoring
- WF09 — Audit Log

## Ghi chú chức năng
- API `GET /api/tickets`: lấy danh sách ticket.
- API `POST /api/tickets`: tạo ticket và gọi webhook n8n nếu `N8N_WEBHOOK_URL` được cấu hình.
- API `PATCH /api/tickets/[id]`: cập nhật trạng thái ticket.
- Trợ lý chat trên giao diện hiện dùng câu trả lời demo ở phía client; nó chưa gọi mô hình AI thật hoặc workflow n8n. Cần tích hợp endpoint/AI provider riêng nếu muốn câu trả lời AI thực sự.

## Bảo mật
File `.env.local` trong bản gốc có chứa thông tin kết nối cơ sở dữ liệu. Bản kết hợp này không kèm thông tin đó. Nếu thông tin đã được chia sẻ hoặc tải lên nơi công khai, hãy đổi mật khẩu database/thu hồi credential cũ và cập nhật URI mới trong `.env.local`.
