# DIMENSION JOURNEY 0D → 5D

App desktop cho phần tương tác Day 3 — Bali projection mapping.
Tường **10350 × 1080**, ra **NDI** (chính, Resolume ở máy khác) hoặc **Spout** (khi cùng một máy).
Tương tác bằng bàn tay: chụm ngón để vẽ, nắm đấm giữ 4s để chuyển chiều, xoè bàn tay để xoay trường 5D.

Nội dung, màu, âm thanh, sáu chiều — giữ nguyên bản prototype
`Dimension Journey 0D-5D (standalone).html`. Cái đổi là: thành app thật, phóng lên cỡ tường,
và có đường ra cho Resolume.

---

## Chạy nhanh

```bash
npm install
npm run build
npm start
```

Cửa sổ **Operator** mở ra. Cửa sổ chiếu và Spout/NDI bật từ trong đó.

> **macOS:** nếu Electron báo `Electron failed to install correctly` hoặc
> `Library not loaded`, giải nén tay:
> ```bash
> cd node_modules/electron && rm -rf dist && mkdir dist \
>   && unzip -q ~/Library/Caches/electron/electron-v33.4.11-darwin-arm64.zip -d dist \
>   && printf 'Electron.app/Contents/MacOS/Electron' > path.txt
> ```

---

## Sơ đồ

```
                 ┌──────────────────────────────┐
  camera / Kinect│  CONTROL (operator)          │
  ──────────────▶│  camera + MediaPipe + tiếng  │
                 └───────────┬──────────────────┘
                             │ HandFrame 60fps (IPC)
                             ▼
                 ┌──────────────────────────────┐
                 │  MAIN — store + broadcast    │
                 └───┬───────────┬──────────┬───┘
                     ▼           ▼          ▼
              cửa sổ chiếu   offscreen    offscreen
              (canh máy)       NDI          Spout
                                │            │
                                │            └─ chỉ khi CÙNG một máy
                                ▼
                      Resolume Arena ở MÁY KHÁC (dây gigabit)
```

**Camera, MediaPipe và âm thanh chỉ tồn tại đúng một bản, ở cửa sổ Control.**
Spout/NDI mỗi cái mở thêm một cửa sổ chạy cùng renderer tường; nếu để tracking hay
tiếng ở đó thì sẽ có 2–3 bản MediaPipe ăn CPU và mỗi nốt nhạc phát chồng 2–3 lần.

---

## Chọn nguồn tương tác

| Nguồn | Khi nào dùng |
|---|---|
| **Camera + MediaPipe** (mặc định) | Người đứng cách 1–2 m và phòng còn đủ sáng. Chính xác nhất — 21 điểm bàn tay, tách được "chụm ngón" với "nắm đấm". |
| **Kinect v2** | Kinect v2 **không có driver UVC** — không `getUserMedia` nào thấy nó, nên nó KHÔNG bao giờ hiện ở ô "Thiết bị"; dù chỉ dùng như webcam thường vẫn phải chạy `KinectBridge.exe`. Chọn **Ảnh Kinect: Màu** (mặc định) là dùng nó đúng như một webcam — 1920×1080 giảm mẫu còn 640×360, chính xác nhất vì MediaPipe được huấn luyện trên ảnh màu. **Hồng ngoại** chỉ khi phòng tối tới mức camera màu mù. Đổi qua lại ngay trên bảng điều khiển, bridge nghe lệnh qua chính WebSocket đang nối. Xem [kinect-bridge/README.md](kinect-bridge/README.md). |
| **Chuột** | Test, và là đường cứu hộ nếu camera chết giữa show. |

Dù chọn nguồn nào thì bộ nhận cử chỉ vẫn luôn là **MediaPipe**, không phải body
tracking của Kinect: hand state của Kinect chỉ có `open`/`closed`/`lasso`, quá thô để
phân biệt chụm ngón với nắm tay — mà đó lại là hai cử chỉ khác nhau trong tác phẩm này.
Kinect chỉ đóng vai **nguồn hình**.

---

## Đường ra

Show chạy **hai máy**: một máy chạy app, một máy chạy Resolume Arena. Vì vậy đường ra
chính là **NDI**; **Spout mặc định TẮT** — Spout chia sẻ texture trong bộ nhớ GPU nên
không bao giờ vượt được sang máy thứ hai.

**NDI** — mặc định BẬT, 30fps, 100% res. Số đo thật (M4 Max, chỉ bề mặt tường):

| Res gửi | fps xin | fps thật | copy/frame | băng thông |
|---|---|---|---|---|
| 10350×1080 | 30 | 27–30 | 5–6 ms | ~335 Mbps |
| 5176×540 (50%) | 30 | 30 | 1–2 ms | ~84 Mbps |
| 10350×1080 | 60 | ~30 | 5–6 ms | — |

Xin 60fps vẫn chỉ ra ~30 vì cửa sổ offscreen raster bằng CPU. Băng thông quy đổi từ mốc
thật của NDI High Bandwidth (1080p60 ≈ 125 Mbps), **không** theo kiểu "nén 1:10" — sai
gấp ba lần.

### Nối được hai máy — làm theo thứ tự này

1. **Dây gigabit, đừng WiFi.** 335 Mbps chạy trên WiFi thì hình giật và trễ, không cứu
   được bằng cách chỉnh app. Hai máy cắm chung một switch gigabit.
2. Hai máy **cùng lớp mạng** (ví dụ `192.168.18.x`). NDI dò nguồn bằng mDNS, khác lớp
   mạng là không thấy nhau.
3. Máy chạy app: mở **Windows Defender Firewall** cho `DIMENSION JOURNEY.exe`, tick
   **cả Private lẫn Public**. Đây là lý do số một khiến máy kia không thấy nguồn.
4. Máy chạy Resolume: cài **NDI Tools / NDI Runtime**, rồi **Sources → NDI** tìm
   `TÊNMÁY (DimensionWall)`.
5. Xem `dimension.log` ở máy app: nó ghi đúng tên nguồn cần tìm, băng thông ước tính, và
   kêu ngay khi fps thật tụt dưới 70% mức xin.

Rớt fps thì hạ **Res gửi** xuống 75% hoặc 50% trước khi đổ tại máy — 50% chỉ tốn 1/4
băng thông và trên màn LED dài 10350px gần như không nhìn ra khác biệt.

**Spout** — chỉ bật khi đổi về setup MỘT máy. Đi hoàn toàn trên GPU: offscreen render với
`useSharedTexture`, lấy shared D3D11 handle, đẩy thẳng qua SpoutDX, không đọc pixel về
RAM. **Đã verify chạy thật vào Resolume Arena.** Trong Resolume thêm nguồn
**Spout In → `DimensionWall`**.

**Lúc chạy show nên ĐÓNG cửa sổ chiếu.** Nó không liên quan gì tới Spout/NDI, mà mở ra
là scene phải render thêm một lần nữa. Control có cảnh báo sẵn khi bạn để mở.

---

## Những núm cần chỉnh tại venue

| Núm | Ý nghĩa |
|---|---|
| **Tầm với** | Mặc định 100%: quét tay hết khung camera = vẽ hết 10 m, một nét chạy được từ tường 1 sang tường 5. Rung ở hai đầu đã xử bằng cách bỏ 9% mép khung camera, nên đừng hạ thanh này trừ khi người xem đứng quá gần camera. |
| **Lan toả 4D / Tiếng vọng 4D** | **Chỉ tầng 4D.** Các tầng khác vẽ ra đúng một nét, không đẻ bản sao. Ở 4D mỗi nét vang thêm mấy bản, rải theo TỪNG MẶT TƯỜNG chứ không random trên 10350 px (random thì mặt 620 cm hứng gấp 3.4 lần mặt 180 cm). Cả hai về 0 là 4D cũng sạch. Log `[spread]` in bảng phủ tường sau mỗi 10 nét. |
| **Ngưỡng chụm** | Chụm khó ăn → tăng. Tự vẽ khi chưa chụm → giảm. |
| **Giữ nắm đấm** | Số giây giữ nắm đấm để sang chiều kế tiếp. Mặc định 4 s. |
| **Lật gương** | Vẽ vòng tròn thấy nét chạy ngược chiều tay → bấm nút này. Phụ thuộc chỗ đặt camera. |
| **Mượt** | Tần số cắt của bộ lọc One Euro. Nét rung → tăng; nét đuổi không kịp → giảm. |
| **Dày nét** | Nét mảnh trên tường 10 m gần như mất. 1.8–2.5× là mức đọc được từ xa. |
| **Góc nhìn ngang** | Càng lớn trường càng rộng, rìa tường càng méo. 100° là mức cân bằng. |
| **Chữ HUD + cỡ** | Chữ 0D/1D/… scale theo tường, tắt được nếu chỉ muốn visual. |

---

## Bốn chỗ bản gốc hỏng khi phóng lên tường 9.58:1

Ghi lại vì nếu sau này sửa scene mà không biết thì sẽ dẫm lại:

1. **Khung hình.** Giữ fov dọc 50° thì góc ngang phọt lên 154°, rìa tường méo như gương cầu.
   Đảo lại: chọn **góc ngang** rồi suy ra fov dọc + khoảng cách camera, sao cho chiều cao
   thế giới luôn = 13 đơn vị. Mọi kích thước tính theo pixel giữ nguyên như bản gốc, chỉ bề
   ngang nở ra (~125 đơn vị).
2. **Cỡ hạt.** three.js tính `gl_PointSize = size × (cao_canvas/2) / khoảng_cách`, **không kể fov**.
   Camera lùi từ 14 ra 52 nên hạt nhỏ đi 3.7 lần. Phải nhân mọi `PointsMaterial.size` với `dist/14`.
   (Sprite là quad trong không gian thế giới nên không dính.)
3. **Giới hạn texture 16384px.** `10350 × devicePixelRatio 2 = 20700` → WebGL chết, và Chromium
   lặng lẽ bỏ shared texture làm **Spout mất tín hiệu mà không báo gì**. `pixelRatio` luôn phải
   kẹp theo `16384/W`.
4. **Xoay tròn không dùng được.** Trường rộng 125 đơn vị mà quay 360° thì phần lớn thời gian
   khán giả nhìn nó nghiêng cạnh, trên tường chỉ còn một vệt. Quỹ đạo 3D/4D và cú xoay 5D đều
   đổi thành đung đưa **có biên**.

Thêm một bẫy nữa, kế thừa thẳng từ prototype: nó vô hiệu hoá `computeBoundingSphere` của
geometry vệt sáng để khỏi tính lại mỗi frame. Nhánh **sortObjects** của `WebGLRenderer` đọc
`boundingSphere.center` **kể cả khi `frustumCulled = false`** — gặp `null` là ném lỗi và chết
cả vòng render. Cách đúng: gán sẵn một quả cầu to vô tận rồi cho `computeBoundingSphere` giữ nguyên nó.

---

## Build .exe Windows

Không build được từ macOS: addon Spout là native, phải biên dịch trên Windows.

- **Cách khuyên dùng** — push lên GitHub, workflow `.github/workflows/build-win.yml` tự build
  và publish `.exe` vào release tag `win-latest`. CI có chốt chặn: thiếu addon Spout hoặc
  thiếu file MediaPipe trong gói là **fail build**, không ship bản câm.
- **Build tay trên Windows** — cần Node 22, Python 3.11, VS 2022 Build Tools (C++):
  ```powershell
  npm install
  cd native\spout && npm install && npx node-gyp rebuild && cd ..\..
  npm run dist:win
  ```

---

## Khi có sự cố ở venue

Bấm **"mở file log"** trong Control. App đóng gói không có terminal, file
`<userData>\dimension.log` là kênh duy nhất để biết máy đang hỏng chỗ nào — nó ghi
GPU adapter nào đang ACTIVE, từng bước của Spout, và **fps thật mỗi 5 giây**.

Cửa sổ chiếu còn có `__djScene` trong DevTools để soi trạng thái thật (số nét, khung hình, con trỏ).

---

## Chưa làm

- **Sàn 3840×2160** — state và đường ra đã có sẵn (`DimensionFloor`), nhưng chưa có scene
  riêng cho sàn nên `main` cố tình chỉ đẩy tường ra Spout/NDI.
- ~~Spout runtime~~ — **ĐÃ CHẠY ĐƯỢC vào Resolume Arena trên máy thật (2026-08-05).**
- **KinectBridge chưa chạy trên phần cứng thật** — nó đã BIÊN DỊCH được (CI build sẵn
  `KinectBridge.zip` vào release, và assembly Kinect lấy từ NuGet nên mọi API gọi tới
  đều được trình biên dịch xác nhận là có thật). Nhưng chưa ai cắm Kinect vào chạy thử.
