# HelpDeskAI — bộ 9 workflow n8n

## Import
1. Mở n8n tại http://localhost:5678.
2. Mở Workflows → Import from File.
3. Import lần lượt 9 file JSON trong thư mục này.
4. Lưu tất cả workflow.
5. Kích hoạt (Active) các workflow từ WF09 ngược về WF01 để tránh gọi vào workflow chưa active.

## Luồng
WF01 Ticket Intake → WF02 Classification → WF03 Priority → WF04 Team Assignment → WF05 Duplicate Detection → WF06 Support Response → WF07 High Priority Alert → WF08 SLA Monitoring → WF09 Audit Log.

Các workflow gọi nhau bằng HTTP tới `http://localhost:5678/webhook/...`. Nếu n8n chạy trong Docker, `localhost` trong n8n là container n8n; URL cần đổi thành hostname/địa chỉ mà container truy cập được. Với n8n cloud, thay bằng URL production của từng webhook.

## Kiểm thử
Sau khi kích hoạt toàn bộ workflow, gửi POST đến:
`http://localhost:5678/webhook/ticket-intake`

Body JSON:
```json
{
  "ticketId": "TCK-100001",
  "title": "Lỗi WiFi",
  "description": "Không kết nối được WiFi",
  "status": "Open"
}
```

PowerShell:
```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:5678/webhook/ticket-intake" -ContentType "application/json" -Body '{"ticketId":"TCK-100001","title":"Loi WiFi","description":"Khong ket noi duoc WiFi","status":"Open"}'
```

## Quan trọng
- Đây là bộ workflow khung chạy được với logic phân loại/ưu tiên dựa trên từ khóa, chưa phải AI/LLM thật.
- WF05 chưa truy vấn MongoDB nên mới tạo fingerprint, chưa xác nhận trùng với ticket đã tồn tại.
- WF07, WF08 và WF09 hiện có **đúng 12 node mỗi workflow**. Xem [bảng 12 bước và hướng dẫn import](WF07-09-12-STEPS.md).
- WF07 đánh dấu ticket High/Critical đang mở cần cảnh báo và soạn thông báo; chưa gửi email/Discord/Slack vì chưa tích hợp kênh nhận.
- WF08 tính SLA khi ticket đi qua workflow: Critical 1h, High 4h, Medium 24h, Low 72h; bỏ đánh dấu quá hạn cho ticket Resolved. Để giám sát định kỳ ticket đang mở, cần thêm Schedule Trigger + truy vấn MongoDB.
- WF09 tạo audit event với bản tổng hợp ticket/alert/SLA và trace đầy đủ; `persisted: false` vì chưa có bước lưu MongoDB.
- Bộ này chưa tự ghi ticket vào MongoDB và chưa gọi ngược API website để cập nhật ticket. Cần tích hợp đúng với code dự án sau khi nhận ZIP.
- Tất cả workflow import ở trạng thái inactive; bật thủ công sau khi kiểm tra URL.
