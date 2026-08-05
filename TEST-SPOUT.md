# Checklist test Spout trên máy Windows

Phần này **chưa ai chạy thử trên máy thật** — mình không có Windows + Resolume.
Làm theo đúng thứ tự dưới đây, và nếu hỏng thì gửi lại file log, đừng đoán.

## 1. Chạy app

Tải `DIMENSION JOURNEY-1.0.0-portable.exe` từ
https://github.com/leoxi2005/dimension-journey/releases/tag/win-latest — chạy thẳng,
không cần cài Node.

Cửa sổ Operator mở ra. **Spout mặc định đã BẬT**, không phải bấm gì thêm.

## 2. Nhìn ô SPOUT trong Control

Đây là chỗ báo bệnh, xem trước khi mở Resolume:

| Thấy gì | Nghĩa là |
|---|---|
| Chấm **xanh** + `DimensionWall · 10350×1080 · 60fps · GPU` | Đang chạy đúng đường GPU. Sang bước 3. |
| Chấm xanh nhưng ghi **`CPU`** kèm `…ms/frame` | Chromium không cấp shared texture nên rơi về đường CPU. **Vẫn có hình**, chỉ nặng hơn. Vẫn sang bước 3, rồi báo lại mình. |
| Chấm **vàng** `đang chờ frame đầu tiên…` | Chưa có frame nào gửi được. Đợi 5 giây, còn vàng thì sang bước 4. |
| Chấm **đỏ** + dòng chữ đỏ | Đó chính là lý do thật. Chép nguyên dòng đó gửi mình. |

## 3. Nhận trong Resolume Arena

Trong Resolume: **Sources → Spout → `DimensionWall`** (kéo vào layer như mọi nguồn khác).

Nếu Resolume không thấy tên nào: mở **SpoutSettings** hoặc **SpoutPanel** (kèm theo bộ
Spout) xem có sender `DimensionWall` không.
- Có trong SpoutPanel mà Resolume không thấy → vấn đề phía Resolume (thử khởi động lại Resolume **sau khi** app đã chạy).
- SpoutPanel cũng không thấy → vấn đề phía app, sang bước 4.

## 4. Lấy log

Bấm nút **"mở file log"** trong Control (mở thẳng thư mục chứa `dimension.log`).

Gửi mình cả file. Trong đó có sẵn những thứ mình cần:
- GPU adapter nào đang **ACTIVE** (máy 2 GPU mà mở nhầm adapter là fail im lặng)
- `gpu_compositing` có `enabled` không (tắt là không bao giờ có shared texture)
- Từng bước của Spout kèm lý do fail
- **fps thật mỗi 5 giây**

## 5. Nếu chạy được thì thử tiếp

- Bấm **60 / 30 fps**, xem fps thật trong ô Spout có đổi theo không.
- Hạ **Res gửi** xuống 75% / 50% xem có nhẹ đi không (nếu 100% bị giật).
- **ĐÓNG cửa sổ chiếu** nếu bạn có mở — nó không liên quan gì tới Spout, mở ra là
  scene phải render thêm một lần nữa. Control có cảnh báo vàng khi bạn để mở.
- Thử tương tác: chụm ngón vẽ, nắm đấm giữ 1 giây để chuyển chiều, xoè bàn tay ở 5D.
- Chỉnh **Dày nét** và **Tầm với** cho hợp với khoảng cách người đứng thật.

## Ba thứ hay hỏng nhất, biết trước cho đỡ mất thời gian

1. **Máy laptop 2 GPU (Intel + NVIDIA).** Nếu app mở shared texture trên GPU này mà
   Resolume đọc trên GPU kia thì fail *im lặng*. Addon có tự dò adapter, nhưng nếu
   vẫn hỏng: vào **NVIDIA Control Panel → Manage 3D settings → Program Settings**, ép
   cả app lẫn Resolume dùng **cùng một** GPU.
2. **`gpu_compositing` bị tắt.** Xem trong log. Tắt thì Chromium không bao giờ cấp
   shared texture, app sẽ tự rơi về đường CPU (vẫn ra hình, chỉ chậm).
3. **Đổi độ phân giải vượt 16384px một chiều.** Chromium lặng lẽ bỏ shared texture ở
   ngưỡng này. App đã chặn sẵn và báo lỗi rõ, nhưng đừng nhập số to hơn thế.
