# WF07, WF08, WF09 — đúng 12 node mỗi luồng

| Bước | WF07 | WF08 | WF09 |
|---|---|---|---|
| 01 | Nhận webhook | Nhận webhook | Nhận webhook |
| 02 | Chuẩn hóa payload, bỏ vỏ webhook | Chuẩn hóa payload, chốt giờ kiểm tra | Chuẩn hóa payload, chốt giờ audit |
| 03 | Kiểm tra ticket | Kiểm tra ticket | Kiểm tra ticket |
| 04 | Chuẩn hóa priority | Áp dụng chính sách SLA | Chọn snapshot và thông tin actor |
| 05 | Xét điều kiện cảnh báo | Xác định thời gian tạo | Tạo eventId và audit event |
| 06 | Soạn thông báo | Tính hạn SLA | Thêm WF09 vào trace |
| 07 | Chuẩn bị trạng thái gửi | Xác định quá hạn | Kiểm tra tính nhất quán audit |
| 08 | Thêm WF07 vào trace | Chuẩn bị kế hoạch escalation | Chọn document cần lưu |
| 09 | Kiểm tra dữ liệu chuyển tiếp | Thêm WF08 vào trace | MongoDB upsert theo eventId |
| 10 | Gọi WF08 | Gọi WF09 | Xác nhận node ghi thành công, khôi phục ticket |
| 11 | Kiểm tra phản hồi đúng ticket | Kiểm tra phản hồi đúng ticket | Chuẩn bị JSON phản hồi cuối |
| 12 | Respond | Respond | Respond |

## Hành vi nghiệp vụ

- WF07 chỉ đánh dấu cảnh báo cho High/Critical đang Open/In Progress. Resolved/Closed không cảnh báo mới; `Closed` được chuẩn hóa thành `Resolved`. Trạng thái `sent` vẫn false vì chưa cấu hình node gửi thông báo; có message, severity và nhóm nhận dự kiến.
- WF08 áp dụng Critical 1 giờ, High 4 giờ, Medium 24 giờ, Low 72 giờ theo giờ liên tục. Giữ thời điểm tạo hợp lệ; nếu thiếu sẽ ghi rõ dùng giờ nhận (`createdAtSource = received_at`). Ngày hỏng bị từ chối thay vì âm thầm thay bằng giờ hiện tại. Giờ nhận được chốt một lần cho mỗi workflow để tính các trường nhất quán.
- Ticket Resolved không đánh dấu quá hạn mới. Không suy ra ticket từng vi phạm SLA trước khi đóng khi chưa có resolvedAt. Luồng vẫn chạy theo webhook, chưa có kiểm tra định kỳ bằng Schedule Trigger.
- WF09 giữ bước MongoDB và đổi insert thành upsert, collection `ticket_audit`, khóa `eventId`. Payload từ backend cung cấp eventId ổn định theo ticket; trường hợp gọi trực tiếp dùng khóa dựa trên ticketId/status/updatedAt hoặc createdAt. Cần eventId ổn định cho những sự kiện có ý nghĩa độc lập; workflow không tự xác thực actor được gửi trong payload.
- Trước khi kích hoạt, chạy `npm run db:indexes` trên cùng database để có unique partial index eventId. Điều này giữ các audit cũ không có eventId và ngăn hai bản ghi cùng event khi chạy đồng thời. Không tự xóa dữ liệu trùng sẵn có.
- Audit lưu snapshot và kết quả cần thiết, không lưu toàn bộ body/header lồng nhau. Cờ persisted được xác nhận trên phản hồi sau node MongoDB thành công; lỗi MongoDB làm luồng thất bại, không trả HTTP 200 giả.
- Các luồng không yêu cầu `require()` hoặc quyền đọc biến môi trường trong Code node. Giữ nguyên webhook path và binding MongoDB đã có khi sinh lại file. Tất cả export ở trạng thái inactive để người dùng kiểm tra trước khi publish.
- Payload ticket sau chuẩn hóa giới hạn 65.536 ký tự JSON; chỉ lấy tối đa 32 mục trace mỗi lớp và tối đa 16 lớp body. Không mang nguyên header/body lồng nhau qua các HTTP Request tiếp theo.

## Cập nhật trong n8n

1. Cập nhật code và chạy `npm ci`; cấu hình database của ứng dụng và credential MongoDB của WF09 cùng database (`MONGODB_DB`, mặc định `it_helpdesk`).
2. Chạy `npm run db:indexes`.
3. Nếu bản cũ đang active, tắt bản cũ có cùng webhook path rồi import ba JSON mới. Chọn credential MongoDB ở `09 - Upsert Audit in MongoDB`.
4. Các workflow cùng một n8n instance có thể gọi nhau qua localhost:5678, kể cả cùng nằm trong một container. Khi dùng các instance khác nhau, thay URL bước 10 bằng Production Webhook URL tương ứng.
5. Publish/kích hoạt WF09 → WF08 → WF07, thử một ticket High và một ticket Resolved trong Executions. HTTP Request giữa các luồng có timeout 30 giây và kiểm tra phản hồi cuối.

Bộ local hiện hành đã bổ sung chuẩn hóa Webhook cho WF01–WF06. Các luồng này dùng quy tắc, không gọi Ollama trong n8n; website có thể gọi Ollama riêng. Xem [LOCAL-SETUP.md](LOCAL-SETUP.md) để nối đủ 9 luồng.

## Sinh lại JSON

```bash
node scripts/generate-n8n-workflows.mjs --only=WF07,WF08,WF09
npm run test:workflows
```

Nguồn duy nhất cho ba luồng tối ưu nằm trong `scripts/optimized-workflows.mjs`. Hai lần sinh lại cho cùng đầu vào cho cùng JSON; không đổi ID ngẫu nhiên và không ghi đè WF01–WF06 khi dùng `--only`. Gọi generator không có `--only` vẫn sinh đủ cả 9 workflow theo chức năng hiện có.
