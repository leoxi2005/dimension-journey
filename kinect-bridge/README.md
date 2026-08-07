# KinectBridge — cầu nối Kinect v2 → DIMENSION JOURNEY

Chương trình nhỏ chạy trên Windows, đọc Kinect v2 rồi đẩy hình sang app qua WebSocket.

## Vì sao bắt buộc phải có nó

Kinect v2 **không có driver UVC**. Không một `getUserMedia` nào thấy nó, ô "Thiết bị"
trong app sẽ không bao giờ liệt kê nó. Dù bạn chỉ muốn dùng nó như một webcam thường
thì vẫn **bắt buộc** đi qua Kinect SDK 2.0 (COM/.NET, chỉ Windows).

**Dùng Kinect như một camera thường = chế độ `color`, và đó là mặc định.** Bridge lấy
ảnh màu 1920×1080 rồi giảm mẫu còn 640×360 đưa cho MediaPipe — không khác gì một webcam,
chỉ là đường đi vòng qua bridge. Chuyển màu ↔ hồng ngoại bấm thẳng trên bảng điều khiển
của app (mục **Nguồn tương tác → Ảnh Kinect**), bridge đổi theo ngay, không phải khởi
động lại nó.

Nhét SDK đó thẳng vào Electron bằng native addon là đường dài và dễ vỡ, nên tách hẳn
ra một tiến trình: bridge chết thì app vẫn sống, và bạn khởi động lại bridge mà không
phải tắt show.

## Cần cài gì trên máy cắm cảm biến

1. **Kinect for Windows Runtime 2.0** — chỉ cần *runtime*, không cần cả SDK:
   https://www.microsoft.com/en-us/download/details.aspx?id=44559
2. Kinect v2 cắm vào **USB 3.0** qua adapter chính hãng (Kinect Adapter for Windows).
   Kinect v2 ăn gần hết băng thông một cổng USB 3.0 — cắm chung hub với thiết bị khác
   là hay rớt.

## Lấy bản đã biên dịch (khuyên dùng)

Tải **`KinectBridge.zip`** ở release:
https://github.com/leoxi2005/dimension-journey/releases/tag/win-latest

Giải nén, chạy `KinectBridge.exe`. **Không cần cài Visual Studio hay Kinect SDK** —
CI đã biên dịch sẵn với assembly Kinect lấy từ NuGet.

## Hoặc tự build

```powershell
cd kinect-bridge
dotnet build -c Release
```

Ra ở `bin\Release\net48\KinectBridge.exe`. Build được trên **mọi hệ điều hành**
(kể cả macOS/Linux) vì assembly Kinect lấy từ NuGet chứ không trỏ vào chỗ cài SDK —
chạy thì mới cần Windows + cảm biến.

## Chạy

Mở app DIMENSION JOURNEY trước, chọn nguồn **Kinect v2** trong bảng điều khiển
(app chỉ mở cổng nghe khi bạn chọn nguồn này), rồi:

```powershell
KinectBridge.exe
```

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--url=ws://127.0.0.1:9010` | cổng 9010 | Phải khớp ô "Cổng bridge" trong app |
| `--source=color` | color | `color` = camera màu, `ir` = hồng ngoại |
| `--step=3` | 3 | Giảm mẫu ảnh màu: 1920/3 = 640 ngang. Để 2 nếu muốn nét hơn (960), 4 nếu máy yếu |
| `--gain=1.0` | 1.0 | Phơi sáng, **chỉ tác dụng với `--source=ir`**. Tay trắng bệt mất chi tiết → hạ 0.6–0.8. Tay quá tối → tăng 1.3–1.6 |
| `--every=1` | 1 | 1 = 30fps, 2 = 15fps. Tăng nếu CPU nặng |
| `--jpeg` | tắt | Gửi JPEG+base64 thay vì nhị phân thô. CHỈ khi phải đẩy qua mạng thật; cùng máy thì đừng bật, nó chỉ thêm trễ |
| `--quality=70` | 70 | Chất lượng JPEG (chỉ khi bật `--jpeg`) |

Bridge tự nối lại mỗi 2 giây nên chạy trước hay sau app đều được, và tự in
`dang gui NN fps` mỗi 2 giây để bạn biết nó còn sống.

Trong app, chấm cạnh "Cổng bridge" chuyển **xanh** kèm số fps là đã thông.

## Chọn `color` hay `ir` — có quy tắc đo được

| | `--source=color` | `--source=ir` |
|---|---|---|
| Ảnh | màu 1920×1080 → giảm mẫu 640×360 | xám 512×424 |
| Độ chính xác MediaPipe | **cao hơn** (mô hình huấn luyện trên ảnh màu) | thấp hơn |
| Phụ thuộc ánh sáng phòng | **có** | không — Kinect tự rọi IR |
| fps khi thiếu sáng | **tụt còn ~15** (camera tự kéo dài phơi sáng) | ổn định 30 |

**Đây là chỗ đáng lưu ý nhất khi chạy trong phòng chiếu:** Kinect v2 **không cho khoá
phơi sáng** — SDK công khai chỉ cho *đọc* `ColorCameraSettings` chứ không đặt được.
Nghĩa là khi tường chuyển sang cảnh tối (0D gần như đen tuyệt đối), camera màu sẽ tự
kéo dài phơi sáng: **tụt fps và nhoè chuyển động, đúng lúc người ta đang vẽ.**

**Cách quyết định, không phải đoán:**

1. Chạy `--source=color`, để tường chạy **0D** (cảnh tối nhất).
2. Nhìn số fps ở ô "Cổng bridge" trong app.
3. Còn ≥25fps và tay bắt ổn → giữ `color`, nó chính xác hơn.
4. Tụt xuống ~15fps, hoặc nét trôi/mất dấu khi cảnh tối → **đổi sang `--source=ir`**.

IR đánh đổi một chút độ chính xác để lấy sự **ổn định bất kể nội dung tường**. Với một
tác phẩm mà độ sáng thay đổi liên tục theo chính nó, đổi như vậy thường là đáng.

## Đặt Kinect ở đâu

- Cách người **1–2 m**, ngang tầm ngực, hướng thẳng vào người.
- Góc nhìn camera màu 84°×54°, IR 71°×60° — ở 1,5 m thì khung ngang phủ ~2,7 m.
  Đứng lệch ra ngoài khoảng đó là mất tay.
- **Đừng để Kinect nhìn ngược vào chùm sáng máy chiếu** — cả ảnh màu lẫn IR đều loá.
- Vẽ vòng tròn mà nét chạy ngược chiều tay → bấm **"lật gương"** trong app, không phải
  đi chuyển chỗ Kinect.

## Giao thức (nếu muốn thay Kinect bằng cảm biến khác)

**Dạng nhị phân — mặc định.** Mỗi frame là một message WebSocket binary:

```
byte 0..3   'D' 'J' 'I' 'R'
byte 4..5   width    (uint16, little endian)
byte 6..7   height   (uint16, little endian)
byte 8      channels (1 = xám 8-bit, 3 = RGB 8-bit)
byte 9      dành chỗ, để 0
byte 10..   width*height*channels byte pixel, theo hàng từ trên xuống
```

Không nén, không base64. Cùng một máy thì băng thông không hề thiếu, mà **độ trễ mới
là thứ đắt nhất** trong chuỗi tương tác này.

**Dạng text — tương thích, dùng khi phải qua mạng thật:**

```json
{ "t": 1738742400000, "ir": "<base64 JPEG>", "hand": { "x": 0.52, "y": 0.41, "z": 1.85, "state": "closed" } }
```

App tự nhận ra dạng nào và tự co theo kích thước thật. `hand` là tuỳ chọn, có thể `null`.

Trường `hand` chở hand state thô của Kinect (`open`/`closed`/`lasso`) nhưng app **chưa
dùng** — nó quá thô để tách "chụm ngón" khỏi "nắm đấm", vốn là hai cử chỉ khác nhau
trong tác phẩm này. Bộ nhận cử chỉ luôn là MediaPipe; Kinect chỉ đóng vai nguồn hình.

## Hỏng thì xem gì

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Không thấy `Kinect: SAN SANG` | Chưa cài Kinect Runtime 2.0, hoặc cắm nhầm cổng USB 2.0 |
| `Chua noi duoc` lặp mãi | App chưa mở, hoặc **chưa chọn nguồn Kinect v2 trong app** (app chỉ mở cổng khi chọn nguồn này), hoặc sai số cổng |
| Nối được nhưng app không thấy hình | Xem ô xem trước trong app — nó vẽ thẳng hình từ Kinect. Đen thui = frame không tới |
| `bo N frame vi gui khong kip` | Máy quá tải → tăng `--every=2` hoặc `--step=4` |
| fps tụt còn ~15 khi cảnh tối | Camera màu tự kéo phơi sáng → đổi `--source=ir` |
