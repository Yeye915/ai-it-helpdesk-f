# WF07, WF08, WF09 — mỗi workflow đúng 12 node

Mỗi số bên dưới tương ứng một node thật trên n8n, bao gồm Webhook đầu vào và Respond đầu ra. Tất cả node đều được nối và chạy theo thứ tự; không có node trang trí hoặc node bị ngắt kết nối. Cách bố trí gồm hai hàng, mỗi hàng 6 node, nối theo đường đi hình chữ U.

## Danh sách 12 bước

| Bước | WF07 — High Priority Alert | WF08 — SLA Monitoring | WF09 — Audit Log |
|---|---|---|---|
| 01 | Webhook nhận ticket | Webhook nhận ticket | Webhook nhận ticket |
| 02 | Chuẩn hóa dữ liệu webhook | Chuẩn hóa dữ liệu webhook | Chuẩn hóa dữ liệu webhook |
| 03 | Kiểm tra mã ticket và kiểu dữ liệu | Kiểm tra mã ticket và kiểu dữ liệu | Kiểm tra mã ticket và kiểu dữ liệu |
| 04 | Chuẩn hóa mức ưu tiên | Áp dụng chính sách SLA | Trích thông tin người thực hiện |
| 05 | Xác định ticket cần cảnh báo | Xác định thời điểm tạo ticket | Chọn các trường cho bản chụp ticket |
| 06 | Soạn nội dung cảnh báo | Tính thời điểm hết hạn | Tổng hợp trạng thái cảnh báo |
| 07 | Chuẩn bị kế hoạch thông báo | Kiểm tra đã vượt hạn hay chưa | Tổng hợp kết quả SLA |
| 08 | Thêm WF07 vào lịch sử xử lý | Chuẩn bị kế hoạch chuyển cấp | Thêm WF09 vào lịch sử xử lý |
| 09 | Kiểm tra dữ liệu chuyển sang SLA | Thêm WF08 vào lịch sử xử lý | Tạo bản ghi audit và mã sự kiện |
| 10 | HTTP POST sang WF08 | HTTP POST sang WF09 | Kiểm tra tính nhất quán bản ghi audit |
| 11 | Kiểm tra phản hồi từ luồng sau | Kiểm tra phản hồi từ luồng sau | Chuẩn bị JSON kết quả, bỏ dữ liệu tạm |
| 12 | Trả JSON cho bên gọi | Trả JSON cho bên gọi | Trả JSON cho bên gọi |

Node Code chạy chế độ Run Once for All Items, lấy ticket đầu vào qua `$input.first().json`. Các webhook nhận một ticket mỗi yêu cầu; không nhận mảng ticket.

## WF07: quy tắc cảnh báo

- `Critical` và `High` cần cảnh báo khi trạng thái là `Open` hoặc `In Progress`.
- `Resolved`, `Medium`, `Low` không yêu cầu cảnh báo mới.
- Priority và status được chuẩn hóa chữ hoa/thường; giá trị không hỗ trợ bị từ chối. Thiếu priority mặc định `Medium`, thiếu status mặc định `Open`.
- Nội dung cảnh báo gồm mã ticket, tiêu đề, ưu tiên và đội phụ trách.
- `alert.sent` luôn `false`: chưa có node gửi email/Telegram/Slack. Với ticket cần cảnh báo, `alert.status` là `pending_configuration`; các ticket còn lại là `not_required`. Không đánh dấu đã gửi khi mới soạn thông báo.
- Bước 11 kiểm tra phản hồi có `processingComplete`, audit event và đúng mã ticket ban đầu.

## WF08: chính sách SLA

| Priority | Thời lượng |
|---|---:|
| Critical | 1 giờ |
| High | 4 giờ |
| Medium | 24 giờ |
| Low | 72 giờ |

`dueAt = createdAt + targetHours`. Đây là giờ liên tục, chưa tính lịch làm việc.

- Giữ `createdAt` hợp lệ được gửi đến. Nếu thiếu, lấy giờ nhận yêu cầu và ghi rõ `sla.createdAtSource = received_at`; trường hợp có thời điểm tạo dùng `ticket_created_at`. Ngày không hợp lệ bị từ chối.
- `breached` chỉ đúng khi ticket chưa `Resolved` và thời gian kiểm tra lớn hơn hạn. Tại đúng thời điểm hết hạn vẫn chưa đánh dấu quá hạn.
- Bổ sung `evaluatedAt`, `state`, `overdueMinutes` và kế hoạch chuyển cấp. `escalationSent` luôn `false` vì chưa tích hợp kênh gửi.
- Ticket đã đóng có `state = resolved`; kết quả này không xác định ticket từng vi phạm SLA trước khi đóng hay không, vì chưa có `resolvedAt` để đối chiếu.
- Workflow chạy khi webhook được gọi; chưa có Schedule Trigger, truy vấn MongoDB hoặc cập nhật SLA vào website.

## WF09: nội dung audit

- Tạo sự kiện `ticket.processed`; `eventId` kết hợp mã ticket và execution ID của n8n, phân biệt các lần chạy. Đây chưa phải cơ chế chống chạy lặp giữa các execution.
- Ghi thời gian xử lý, thông tin actor được cung cấp, bản chụp ticket, bản tổng hợp alert/SLA và lịch sử các luồng đã đi qua. Actor mặc định là `system`; actor từ payload chưa được xác thực bằng phiên website.
- Chỉ chọn các trường phục vụ ticket/audit, không sao chép header webhook, trường mật khẩu, URI database hoặc toàn bộ đối tượng actor vào audit.
- Cập nhật cả `workflowTrace` bên ngoài và `auditLog.workflowTrace`, bao gồm WF09.
- `auditLog.persisted = false`, `storageStatus = not_configured`: chưa có node ghi audit vào MongoDB.
- `processingComplete = true` nghĩa là kết thúc xử lý của chuỗi, không có nghĩa ticket đã được giải quyết, thông báo đã gửi hoặc dữ liệu đã lưu.

## Import và nối các workflow

1. Cập nhật source và chọn ba file JSON WF07, WF08, WF09 trong thư mục này.
2. Nếu bản cũ đang active, tắt bản cũ trước khi kích hoạt bản thay thế vì các webhook path được giữ nguyên.
3. Import từng file vào n8n. Mỗi file có đúng 12 node, tên bắt đầu từ `01` đến `12`; trạng thái export là inactive.
4. URL mặc định ở bước 10 của WF07 là `http://localhost:5678/webhook/sla-monitoring`, của WF08 là `http://localhost:5678/webhook/audit-log`. URL này dùng khi cả ba workflow cùng một instance n8n, kể cả cùng chạy trong một container. Khi các workflow ở instance khác nhau, thay bằng Production URL tương ứng.
5. Lưu/publish và kích hoạt theo thứ tự WF09 → WF08 → WF07.
6. Gửi một ticket thử vào Production Webhook WF07, rồi xem Executions. WF07 và WF08 đợi luồng sau hoàn tất; timeout mỗi HTTP Request là 10 giây. Lỗi xác thực đầu vào, lỗi downstream hoặc timeout làm execution thất bại, không trả kết quả thành công giả.

Payload mẫu:

```json
{
  "ticketId": "TCK-100001",
  "title": "Mất kết nối Wi-Fi",
  "description": "Nhiều người không truy cập được mạng",
  "priority": "High",
  "status": "Open",
  "createdAt": "2026-10-31T02:00:00.000Z"
}
```

WF07–WF09 nhận được cả JSON ở cấp root, body của Webhook và các body lồng nhau của chuỗi cũ. Việc phục hồi dữ liệu không thay đổi cách WF02–WF06 đã phân loại/đánh giá ticket; các luồng đó vẫn dùng logic hiện tại của chúng. Riêng website hiện không gửi `createdAt`/`status` trong webhook, và chưa sử dụng phản hồi n8n để ghi các trường alert/SLA/audit vào MongoDB. Các file workflow này không thay đổi phần backend đó.

## Kiểm thử tự động

Từ thư mục gốc repository:

```bash
node --test tests/workflows.test.mjs
```

Bộ kiểm tra xác nhận cấu trúc và số node, thực thi JavaScript lấy trực tiếp từ JSON, kiểm tra priority/status, các trường hợp hạn SLA, bản ghi audit, lỗi đầu vào và handoff đã serialize giữa 3 luồng. HTTP Request được mô phỏng theo hợp đồng JSON; đây không phải xác nhận đã import/chạy trong instance n8n của người dùng. Sau khi import, cần kiểm tra một execution thật trên n8n.
