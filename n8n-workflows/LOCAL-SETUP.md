# Chạy bộ 9 workflow trên Ubuntu với n8n local

Bộ chính thức có 9 file WF01–WF09, không phải 16 workflow. Các bản import trùng trong n8n không phải luồng bổ sung của dự án.

## 1. Cập nhật file

Trong thư mục repo Yeye915/ai-it-helpdesk-f:

```bash
git pull --ff-only origin main
npm ci
npm run db:indexes
```

Giữ cấu hình MongoDB riêng trong `.env.local`; không đưa thông tin đăng nhập lên GitHub. `db:indexes` chỉ tạo index trên database được cấu hình. Credential MongoDB trong n8n phải trỏ cùng database với ứng dụng (mặc định `it_helpdesk`). Atlas cần cho phép IP public của nơi chạy n8n và database user phải có quyền đọc/ghi database đó.

## 2. Thay thế workflow trong n8n

1. Mở http://localhost:5678 trong Ubuntu.
2. Download/backup những workflow đã chỉnh sửa riêng. Tắt/Unpublish các bản WF01–WF09 cũ, kể cả bản trùng, để giải phóng các webhook path.
3. Tạo workflow mới → menu ba chấm → Import from File. Import lần lượt đúng 9 file `WF01_*.json` đến `WF09_*.json` trong thư mục này. Đừng import file Markdown.
4. Sau khi bản mới chạy được, archive các bản cũ/trùng. Không cần xóa dữ liệu n8n hoặc volume Docker.
5. Tại WF09, mở `09 - Upsert Audit in MongoDB`, chọn credential MongoDB của bạn và kiểm tra kết nối.
6. Mỗi node Call Next Workflow đã dùng POST, JSON và Production URL của luồng kế tiếp. Các URL `http://localhost:5678/webhook/...` phù hợp khi cả 9 luồng cùng chạy trong một n8n instance/container.
7. Save và Publish/Activate theo thứ tự WF09 → WF08 → ... → WF01. Các file export mặc định inactive. Không dùng `/webhook-test/` cho dây chuyền production.

## 3. Các webhook path

| Luồng | Path |
|---|---|
| WF01 | ticket-intake |
| WF02 | ticket-classification |
| WF03 | priority-assessment |
| WF04 | team-assignment |
| WF05 | duplicate-detection |
| WF06 | support-response |
| WF07 | high-priority-alert |
| WF08 | sla-monitoring |
| WF09 | audit-log |

Mỗi đường dẫn đầy đủ là `http://localhost:5678/webhook/` cộng path trong bảng.

## 4. Chạy thử trực tiếp từ Terminal Ubuntu

Bật cả 9 workflow và cấu hình MongoDB trước khi chạy:

```bash
curl --fail-with-body --max-time 45 \
  -X POST http://localhost:5678/webhook/ticket-intake \
  -H 'Content-Type: application/json' \
  -d '{"ticketId":"TCK-DEMO-001","eventId":"demo:TCK-DEMO-001:created","title":"Wi-Fi outage","description":"All users cannot work","status":"Open"}'
```

Kết quả mong đợi: `ticketId` giữ nguyên, `category: Network`, `priority: High`, `alert.required: true`, `alert.sent: false`, `sla.targetHours: 4`, `auditLog.persisted: true`, `processingComplete: true`. `workflowTrace` có WF01 đến WF09. Xem Executions từng luồng và bản ghi `ticket_audit` có eventId `demo:TCK-DEMO-001:created`.

Gửi lại đúng eventId cập nhật audit hiện có. Demo này thiếu createdAt nên WF01 lấy thời điểm nhận; muốn thử quá hạn, đặt createdAt là thời điểm cách hiện tại hơn 4 giờ (chuỗi ISO hợp lệ).

## 5. Nối website chạy trực tiếp trên Ubuntu

Trong `.env.local` của website:

```env
N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook/ticket-intake
```

Khởi động lại Next.js rồi tạo ticket. Website gọi webhook sau khi lưu ticket; kết quả n8n không tự cập nhật lại các trường của ticket trong website.

Nếu backend website chạy trên máy/VPS khác, `127.0.0.1` là máy đó, không phải Ubuntu của bạn. Cần địa chỉ n8n mà backend ấy truy cập được. Hướng dẫn này ưu tiên chạy website và n8n cùng Ubuntu, không cần n8n Cloud hay tunnel công khai.

## 6. Phạm vi thực tế và kiểm chứng

- WF01–WF06 xử lý bằng quy tắc và mẫu phản hồi; bộ n8n này không yêu cầu Ollama. Website vẫn có thể dùng Ollama riêng để phân loại trước khi gọi n8n.
- WF05 chuẩn bị fingerprint, chưa tìm trùng trong database (`checked: false`).
- WF07/WF08 chuẩn bị cảnh báo/chuyển cấp, chưa gửi email hoặc tin nhắn thật. WF08 kiểm tra khi nhận webhook, chưa có lịch quét định kỳ.
- WF09 ghi audit thực tế khi credential đúng. Test curl chỉ ghi audit, không tạo document ticket trong collection `tickets`; tạo ticket từ website sẽ đi qua backend lưu ticket trước.
- Đã kiểm thử mã Code node của chuỗi 1→9 với lớp bọc Webhook, JSON HTTP và các ca High/Low/Resolved; kiểm thử native node theo hợp đồng dữ liệu. Kiểm thử backend có kiểm tra MongoDB local. Chưa import/publish lên instance n8n của bạn, nên cần thực hiện test ở mục 4 để xác nhận môi trường thật.

Lỗi thường gặp: HTTP 404 → chưa Publish hoặc sai Production URL; webhook path bị trùng → tắt bản cũ; ECONNREFUSED localhost:5678 → n8n chưa chạy hoặc khác instance; MongoDB auth/timeout → kiểm tra credential/database/IP Atlas.
