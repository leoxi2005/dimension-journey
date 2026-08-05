# DIMENSION JOURNEY 0D → 5D

App desktop cho phần tương tác Day 3 — Bali projection mapping.
Tường **10350 × 1080**, ra **Spout** (chính) và **NDI** (dự phòng) cho **Resolume Arena**.
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
              cửa sổ chiếu   offscreen   offscreen
              (canh máy)      Spout        NDI
                                │            │
                                ▼            ▼
                          Resolume Arena  (máy khác)
```

**Camera, MediaPipe và âm thanh chỉ tồn tại đúng một bản, ở cửa sổ Control.**
Spout/NDI mỗi cái mở thêm một cửa sổ chạy cùng renderer tường; nếu để tracking hay
tiếng ở đó thì sẽ có 2–3 bản MediaPipe ăn CPU và mỗi nốt nhạc phát chồng 2–3 lần.

---

## Chọn nguồn tương tác

| Nguồn | Khi nào dùng |
|---|---|
| **Camera + MediaPipe** (mặc định) | Người đứng cách 1–2 m và phòng còn đủ sáng. Chính xác nhất — 21 điểm bàn tay, tách được "chụm ngón" với "nắm đấm". |
| **Kinect v2** | Kinect v2 **không có driver UVC** — không `getUserMedia` nào thấy nó, nên dù chỉ dùng như webcam thường vẫn phải chạy `KinectBridge.exe`. Bridge gửi được **ảnh màu** (phòng đủ sáng, chính xác nhất) hoặc **ảnh hồng ngoại** (phòng tối om). Xem [kinect-bridge/README.md](kinect-bridge/README.md). |
| **Chuột** | Test, và là đường cứu hộ nếu camera chết giữa show. |

Dù chọn nguồn nào thì bộ nhận cử chỉ vẫn luôn là **MediaPipe**, không phải body
tracking của Kinect: hand state của Kinect chỉ có `open`/`closed`/`lasso`, quá thô để
phân biệt chụm ngón với nắm tay — mà đó lại là hai cử chỉ khác nhau trong tác phẩm này.
Kinect chỉ đóng vai **nguồn hình**.

---

## Đường ra

**Spout** — cùng máy Windows với Resolume. Toàn bộ đi trên GPU: offscreen render với
`useSharedTexture`, lấy shared D3D11 handle, đẩy thẳng qua SpoutDX. Không đọc pixel về
RAM, không nén. Trong Resolume thêm nguồn **Spout In → `DimensionWall`**.

**NDI** — chỉ khi Resolume ở máy khác. Số đo thật trên máy dev (M4 Max):

| Res gửi | fps xin | fps thật | copy/frame |
|---|---|---|---|
| 10350×1080 | 30 | 30 | 5–6 ms |
| 5176×540 (50%) | 30 | 30 | 1–2 ms |
| 10350×1080 | 60 | ~30 | 5–6 ms |

Xin 60fps vẫn chỉ ra ~30 vì offscreen render trên macOS raster bằng CPU.

**Lúc chạy show nên ĐÓNG cửa sổ chiếu.** Nó không liên quan gì tới Spout/NDI, mà mở ra
là scene phải render thêm một lần nữa. Control có cảnh báo sẵn khi bạn để mở.

---

## Những núm cần chỉnh tại venue

| Núm | Ý nghĩa |
|---|---|
| **Tầm với** | 100% = quét tay đi hết 10 m tường. Hạ nếu nét giật ở hai đầu. |
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
- **Spout runtime chưa test trên máy thật** — mình không có Windows + Resolume để chạy thử.
  Đường code kế thừa từ project DAY3 (đã hardened: tự dò DXGI adapter, keyed mutex, CPU
  fallback khi Chromium không cấp shared texture). Bạn test và gửi lại `dimension.log` nếu lỗi.
- **KinectBridge chưa biên dịch thử** — cần Windows + Kinect SDK 2.0.
