# Backend và WF07–WF09 sau tối ưu

## Các thay đổi backend

- Giữ nguyên kiểm tra phiên và nguồn request trên các API. GET `/api/tickets` không có tham số giữ toàn bộ danh sách cho dashboard hiện tại (một truy vấn lean); dùng `?page=1` để bật phân trang/thống kê.
- Giữ nguyên bốn nhóm URL API và định dạng phản hồi đang được giao diện sử dụng, gồm `data`, `priorityTickets`, `meta`, `summary`, `reply`, `suggestion`.
- Danh sách ticket gộp 5 chỉ số dashboard vào một aggregate. Với chế độ phân trang không lọc, dùng 3 lệnh đọc collection tickets thay cho 8 lệnh ở bản phân trang HelpMetaAI; trường hợp vừa lọc vừa thống kê dùng 4 lệnh. Trang ưu tiên đầu tiên không lọc tái sử dụng chính danh sách để lấy preview. Không công bố số đo độ trễ chưa được benchmark.
- Dùng `.lean()` khi đọc/cập nhật, giới hạn thời gian truy vấn, thứ tự phụ `_id` để phân trang ổn định, escape ký tự regex khi tìm kiếm, và chặn page không phải số nguyên an toàn.
- Bổ sung index cho thứ tự tạo, status + thời điểm tạo, và thứ tự cập nhật. Sắp xếp theo ưu tiên vẫn cần aggregate tính thứ hạng; không giả định có index cho biểu thức này.
- Cache một promise kết nối MongoDB cho các request đồng thời; bỏ promise sau khi hoàn tất để không khóa các lần retry. Giữ pool tối đa 10 kết nối và timeout hữu hạn.
- Dữ liệu JSON được đọc có giới hạn byte trước khi parse: mặc định 64 KiB, chat 512 KiB. Reject `null`, mảng, JSON hỏng và kiểu dữ liệu sai với lỗi 4xx trước khi gọi AI hoặc ghi dữ liệu.
- Ticket mới dùng UUID thay cho không gian ngẫu nhiên 6 chữ số để giảm nguy cơ trùng mã. Ticket cũ vẫn đọc và cập nhật bình thường.
- Các endpoint AI dùng chung một model và endpoint, giới hạn prompt/history, context, output và số yêu cầu đồng thời. Giữ hàm `analyzeTicket` để tương thích code gọi cũ.
- Lỗi AI được phân biệt: 429 khi hết slot, 502 khi provider trả lỗi/dữ liệu sai, 503 khi không kết nối được, 504 khi quá hạn. Client hủy request thì hủy fetch và giải phóng slot. Không ghi raw nội dung lỗi provider hoặc URI database vào phản hồi/log.
- Webhook dùng `after()` của Next.js để được theo dõi sau khi trả response. Kiểm tra cả HTTP status và timeout; không tự retry POST. Payload có `eventId`, `status`, `createdAt`, `updatedAt` để SLA và audit giữ đúng danh tính/thời điểm. Đây là best-effort, không phải hàng đợi bền vững; kết quả n8n chưa được ghi lại vào ticket trên website.
- Seed dùng scrypt bất đồng bộ, một bulk write, kiểm tra email trùng trước khi ghi và xác minh kết quả. Chạy seed vẫn cập nhật tên/vai trò/mật khẩu của email đã khai báo như trước.

Giữ nguyên đăng ký, đăng nhập, cookie HttpOnly, kiểm tra origin và hỗ trợ cả hai định dạng hash mật khẩu hiện có.

## Cấu hình và triển khai

```bash
npm ci
# Chỉ tạo .env.local từ mẫu nếu chưa có cấu hình riêng.
npm run db:indexes
npm run build
npm run start
```

Chỉnh cấu hình trong `.env.local`, tham khảo `.env.example`. Tạo index trên đúng database trước khi bật WF09 mới. Script chỉ tạo index, không xóa index hay dữ liệu; nếu đã có eventId trùng, việc tạo unique index sẽ báo lỗi để xử lý dữ liệu đó. Index audit là unique partial index cho eventId dạng chuỗi, nên các bản ghi cũ chưa có eventId được giữ nguyên.

### Các biến AI

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OLLAMA_MODEL` | `qwen2.5:3b` | Cùng model cho phân loại, chat và đề xuất |
| `OLLAMA_URL` | Không đặt | Endpoint đầy đủ, ưu tiên hơn `OLLAMA_BASE_URL` |
| `OLLAMA_TIMEOUT_MS` | 120000 | Timeout 1000–300000 ms |
| `OLLAMA_MAX_CONCURRENT` | 1 | Số inference đồng thời trong một process, tối đa 16 |
| `OLLAMA_NUM_CTX` | 4096 | Giới hạn context 1024–32768 |
| `OLLAMA_NUM_PREDICT` | 1024 | Giới hạn output 64–4096 token |

Giới hạn đồng thời áp dụng trong từng process Next.js, không phải khóa phân tán giữa nhiều replica. Đổi model theo model thực tế đã tải; Bộ n8n local WF01–WF06 hiện dùng quy tắc, không gọi Ollama; Ollama của backend website được cấu hình độc lập.

## Kiểm thử

Cần MongoDB local đang chạy. Các lệnh bên dưới không dùng Atlas và không gửi thông báo thật:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/it_helpdesk npm run test:backend
npm run test:workflows
npm run lint
npm run build
```

Test backend tạo database riêng có tên ngẫu nhiên, chạy Next.js trên cổng local trống, dùng HTTP server mô phỏng Ollama/n8n, rồi dọn riêng database đó. Bao gồm kiểm tra số lệnh đọc qua profiler MongoDB của database kiểm thử, timeout/cancel/backpressure, payload xấu, phân trang/tìm kiếm/cập nhật, webhook, seed và upsert audit thực tế. Không lấy các số đo thời gian từ provider mô phỏng làm bằng chứng tăng tốc inference thật.

Test workflow thực thi JavaScript lấy từ JSON, kiểm tra đường nối 12 node, các nhánh nghiệp vụ, dữ liệu truyền qua webhook và chạy lại generator. Các bước native n8n được kiểm tra theo hợp đồng dữ liệu; vẫn cần import và chạy thử trên instance n8n đã cấu hình credential MongoDB.

## Kiểm chứng trên Yeye915/ai-it-helpdesk-f

Đã chạy `npm ci`, lint, 16 kiểm thử backend (bao gồm chạy lại bộ auth/seed hiện có), 12 kiểm thử workflow, kiểm thử trình duyệt authenticated navigation/reload và production build Next.js 16.4.2. Tất cả đạt. Kiểm thử chỉ dùng MongoDB loopback và mock Ollama/n8n; chưa import/publish trên n8n thật. Giữ nguyên các phiên bản dependency hiện có; thêm tsx cho kiểm thử TypeScript.
