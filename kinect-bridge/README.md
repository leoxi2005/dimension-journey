# KinectBridge — cầu nối Kinect v2 → DIMENSION JOURNEY

Chương trình nhỏ chạy trên Windows, đọc Kinect v2 rồi đẩy sang app qua WebSocket.

## Vì sao cần một tiến trình riêng

Kinect v2 **không** hiện ra như webcam UVC — không có `getUserMedia` nào thấy nó.
Muốn đọc phải qua Kinect SDK 2.0 (COM/.NET, chỉ Windows). Nhét SDK đó thẳng vào
Electron bằng native addon là đường dài và dễ vỡ, nên tách hẳn ra: bridge chết thì
app vẫn sống, và bạn khởi động lại bridge mà không phải tắt show.

## Thứ đáng giá nhất là ảnh hồng ngoại, không phải skeleton

Phòng projection mapping tối om. Webcam RGB trong đó gần như mù, MediaPipe sẽ mất
dấu tay liên tục. Kinect **tự rọi hồng ngoại**, nên ảnh IR của nó sáng rõ bất kể
đèn phòng. Bridge gửi ảnh IR đó sang app, app chạy MediaPipe HandLandmarker trên
ảnh IR — vẫn đủ 21 điểm để bắt cử chỉ chụm ngón.

Hand state thô của Kinect (`open` / `closed` / `lasso`) cũng được gửi kèm trong
trường `hand`, nhưng app **chưa dùng** — nó quá thô để phân biệt "chụm ngón" với
"nắm tay", vốn là hai cử chỉ khác nhau trong tác phẩm này. Trường này để sẵn cho
sau này nếu cần một đường dự phòng khi MediaPipe mất dấu.

## Cần cài gì

1. **Kinect for Windows SDK 2.0** — https://www.microsoft.com/en-us/download/details.aspx?id=44561
2. **.NET Framework 4.8 Developer Pack** (hoặc Visual Studio 2022 có workload .NET desktop)
3. Kinect v2 cắm vào **USB 3.0** qua adapter chính hãng (Kinect Adapter for Windows).

Kiểm tra trước bằng **Kinect Studio** hoặc **SDK Browser → Infrared Basics**: thấy
được ảnh IR ở đó thì bridge mới chạy được.

## Build

```powershell
cd kinect-bridge
dotnet build -c Release
```

File ra: `bin\Release\net48\KinectBridge.exe`

Nếu báo không tìm thấy `Microsoft.Kinect.dll`, sửa lại `HintPath` trong
`KinectBridge.csproj` cho đúng chỗ bạn cài SDK.

## Chạy

Mở app DIMENSION JOURNEY trước, chọn nguồn **Kinect v2 (IR)** trong bảng điều
khiển (app sẽ mở cổng nghe), rồi:

```powershell
KinectBridge.exe
```

Tuỳ chọn:

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `--url=ws://127.0.0.1:9010` | cổng 9010 | Phải khớp ô "Cổng bridge" trong app |
| `--gain=1.0` | 1.0 | Phơi sáng IR. Bàn tay trắng bệt mất hết chi tiết → hạ xuống 0.6–0.8. Tay quá tối → tăng lên 1.3–1.6 |
| `--every=1` | 1 | 1 = 30fps, 2 = 15fps. Tăng lên nếu CPU nặng |
| `--jpeg` | tắt | Chuyển sang gửi JPEG+base64 thay vì nhị phân thô. CHỈ dùng khi phải đẩy qua mạng thật; cùng máy thì đừng bật, nó chỉ thêm trễ |
| `--quality=70` | 70 | Chất lượng JPEG (chỉ có tác dụng khi bật `--jpeg`) |

Bridge tự nối lại mỗi 2 giây, nên chạy trước hay sau app đều được.

Trong app, chấm cạnh "Cổng bridge" chuyển **xanh** kèm số fps là đã thông.

## Giao thức (nếu bạn muốn thay Kinect bằng cảm biến khác)

**Dạng nhị phân — mặc định, nên dùng.** Mỗi frame là một message WebSocket binary:

```
byte 0..3   'D' 'J' 'I' 'R'
byte 4..5   width   (uint16, little endian)
byte 6..7   height  (uint16, little endian)
byte 8..    width*height byte xám, 8-bit, theo hàng từ trên xuống
```

Không nén, không base64. 512×424 @30fps chỉ 6.5 MB/s trên localhost — rẻ hơn
nhiều so với chi phí nén một đầu rồi giải nén đầu kia. Trong tác phẩm này **độ
trễ là thứ đắt nhất**, nên đừng đánh đổi nó lấy băng thông mà bạn không thiếu.

**Dạng text — tương thích ngược, dùng khi phải qua mạng thật:**

```json
{
  "t": 1738742400000,
  "ir": "<base64 JPEG, ảnh xám>",
  "hand": { "x": 0.52, "y": 0.41, "z": 1.85, "state": "closed" }
}
```

App tự nhận ra dạng nào và tự co theo kích thước thật, không cần đúng 512×424.
`hand` là tuỳ chọn, có thể `null`.

Bất cứ nguồn nào (Azure Kinect, OAK-D, camera IR rời…) nói đúng một trong hai
dạng trên là cắm vào được, không phải sửa app.

## Nếu bạn chỉ cần "thấy được trong tối"

Cân nhắc **webcam IR (UVC) + đèn rọi hồng ngoại 850nm** thay cho Kinect. Nó cắm
vào là app nhận ngay như một camera thường (chọn trong ô "Thiết bị"), **không cần
bridge, không cần Kinect SDK, không thêm một chặng trễ nào**, và chạy được 60fps
thay vì trần 30fps của Kinect.

Kinect chỉ hơn khi bạn cần thứ mà tác phẩm này hiện KHÔNG dùng: chiều sâu để lọc
người đi phía sau, hoặc nhiều người cùng lúc.
