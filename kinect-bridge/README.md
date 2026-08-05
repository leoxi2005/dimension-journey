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
| `--quality=70` | 70 | Chất lượng JPEG. Hạ xuống nếu thấy nghẽn |
| `--every=1` | 1 | 1 = 30fps, 2 = 15fps. Tăng lên nếu CPU nặng |

Bridge tự nối lại mỗi 2 giây, nên chạy trước hay sau app đều được.

Trong app, chấm cạnh "Cổng bridge" chuyển **xanh** kèm số fps là đã thông.

## Giao thức (nếu bạn muốn thay Kinect bằng cảm biến khác)

Mỗi frame là một message WebSocket dạng text, JSON:

```json
{
  "t": 1738742400000,
  "ir": "<base64 JPEG, ảnh xám 512×424>",
  "hand": { "x": 0.52, "y": 0.41, "z": 1.85, "state": "closed" }
}
```

- `ir` — bắt buộc. Ảnh mà MediaPipe sẽ chạy lên. Không cần đúng 512×424; app tự
  co theo kích thước thật.
- `hand` — tuỳ chọn, có thể `null`. `x`/`y` chuẩn hoá 0..1 theo khung ảnh.

Bất cứ nguồn nào (Azure Kinect, OAK-D, camera IR rời…) nói đúng giao thức này là
cắm vào được, không phải sửa app.
