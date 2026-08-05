# KinectBridge — cầu nối Kinect v2 → DIMENSION JOURNEY

Chương trình nhỏ chạy trên Windows, đọc Kinect v2 rồi đẩy sang app qua WebSocket.

## Vì sao vẫn phải có tiến trình riêng, kể cả khi phòng đủ sáng

Kinect v2 **không có driver UVC**. Không một `getUserMedia` nào thấy nó, ô "Thiết
bị" trong app sẽ không bao giờ liệt kê nó. Dù bạn chỉ muốn dùng nó như một webcam
thường thì vẫn **bắt buộc** đi qua Kinect SDK 2.0 (COM/.NET, chỉ Windows). Nhét
SDK đó thẳng vào Electron bằng native addon là đường dài và dễ vỡ, nên tách hẳn
ra: bridge chết thì app vẫn sống, khởi động lại bridge không phải tắt show.

## Chọn nguồn hình: màu hay hồng ngoại

| | `--source=color` (mặc định) | `--source=ir` |
|---|---|---|
| Ảnh | camera màu 1920×1080, giảm mẫu còn 640×360 | hồng ngoại 512×424 |
| Cần ánh sáng | có — phòng phải đủ sáng | không, Kinect tự rọi IR |
| Độ chính xác MediaPipe | **cao nhất** (mô hình huấn luyện trên ảnh màu) | thấp hơn, chưa đo được |
| fps trong phòng tối | tụt xuống ~15 (tự tăng phơi sáng) | ổn định 30 |

**Phòng immersive còn đủ sáng thì dùng `color`.** Chỉ đổi sang `ir` khi thử thực
tế thấy MediaPipe mất dấu tay vì thiếu sáng.

Hand state thô của Kinect (`open` / `closed` / `lasso`) được gửi kèm trong trường
`hand`, nhưng app **chưa dùng** — nó quá thô để phân biệt "chụm ngón" với "nắm
tay", vốn là hai cử chỉ khác nhau trong tác phẩm này. Để sẵn cho đường dự phòng.

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
| `--source=color` | color | `color` = camera màu, `ir` = hồng ngoại |
| `--step=3` | 3 | Giảm mẫu ảnh màu: 1920/3 = 640 ngang. Để 2 nếu muốn nét hơn (960), 4 nếu máy yếu |
| `--gain=1.0` | 1.0 | Phơi sáng, **chỉ có tác dụng với `--source=ir`**. Tay trắng bệt mất chi tiết → hạ 0.6–0.8. Tay quá tối → tăng 1.3–1.6 |
| `--every=1` | 1 | 1 = 30fps, 2 = 15fps. Tăng lên nếu CPU nặng |
| `--jpeg` | tắt | Chuyển sang gửi JPEG+base64 thay vì nhị phân thô. CHỈ dùng khi phải đẩy qua mạng thật; cùng máy thì đừng bật, nó chỉ thêm trễ |
| `--quality=70` | 70 | Chất lượng JPEG (chỉ có tác dụng khi bật `--jpeg`) |

Bridge tự nối lại mỗi 2 giây, nên chạy trước hay sau app đều được.

Trong app, chấm cạnh "Cổng bridge" chuyển **xanh** kèm số fps là đã thông.

## Giao thức (nếu bạn muốn thay Kinect bằng cảm biến khác)

**Dạng nhị phân — mặc định, nên dùng.** Mỗi frame là một message WebSocket binary:

```
byte 0..3   'D' 'J' 'I' 'R'
byte 4..5   width    (uint16, little endian)
byte 6..7   height   (uint16, little endian)
byte 8      channels (1 = xám 8-bit, 3 = RGB 8-bit)
byte 9      dành chỗ, để 0
byte 10..   width*height*channels byte pixel, theo hàng từ trên xuống
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

## Cân nhắc: webcam USB thường có khi còn tốt hơn

Nếu phòng đủ sáng và bạn chỉ cần bàn tay, một **webcam USB thường** thắng Kinect
ở đúng những thứ quan trọng với tác phẩm này:

- cắm vào là app nhận ngay, **không bridge, không SDK, không thêm chặng trễ nào**
- chạy được **60fps**, Kinect trần 30
- góc nhìn hẹp hơn (~60° so với 84° của Kinect) → ở 1–2m bàn tay chiếm nhiều
  pixel hơn trong khung → MediaPipe bắt chính xác hơn

Kinect chỉ hơn khi cần thứ tác phẩm này hiện KHÔNG dùng: chiều sâu để lọc người
đi phía sau, hoặc nhiều người cùng lúc. Bạn đã có sẵn Kinect nên cứ thử trước —
nhưng nếu thấy trễ hoặc thiếu chính xác thì webcam thường là đường lùi rẻ và
**không phải sửa một dòng code nào**.
