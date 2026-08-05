// ============================================================================
// KinectBridge — đọc Kinect v2 rồi đẩy hình sang app DIMENSION JOURNEY qua WebSocket.
//
// VÌ SAO CẦN: Kinect v2 KHÔNG có driver UVC — không một `getUserMedia` nào thấy
// nó. Muốn lấy hình bắt buộc phải qua Kinect SDK 2.0 (COM/.NET, chỉ Windows).
// Nhét SDK đó vào Electron bằng native addon là đường dài và dễ vỡ; tách ra một
// tiến trình nhỏ thì đơn giản, và bridge chết vẫn khởi động lại được giữa show.
//
// HAI NGUỒN HÌNH, chọn bằng --source:
//   color (mặc định) — camera màu 1920×1080, giảm mẫu còn 640×360.
//                      Dùng khi phòng còn đủ sáng. MediaPipe được huấn luyện
//                      trên ảnh màu nên đây là đường chính xác nhất.
//   ir              — camera hồng ngoại 512×424. Kinect tự rọi IR nên thấy tay
//                      kể cả tối om, nhưng MediaPipe chạy trên ảnh xám IR thì
//                      độ chính xác giảm (mô hình không được huấn luyện cho nó).
//
// Ảnh gửi đi dạng NHỊ PHÂN THÔ, không nén, không base64: cùng một máy thì băng
// thông không hề thiếu, mà độ trễ mới là thứ đắt nhất trong chuỗi tương tác này.
// ============================================================================
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Kinect;

namespace KinectBridge
{
    internal static class Program
    {
        // Hệ số chuẩn hoá IR lấy từ mẫu chính thức của Kinect SDK.
        private const float IrSourceValueMaximum = ushort.MaxValue;
        private const float IrOutputValueMinimum = 0.01f;
        private const float IrOutputValueMaximum = 1.0f;
        private const float IrSceneValueAverage = 0.08f;
        private const float IrSceneStandardDeviations = 3.0f;

        private static KinectSensor _sensor;
        private static MultiSourceFrameReader _reader;
        private static ClientWebSocket _ws;

        private static string _url = "ws://127.0.0.1:9010";
        private static string _source = "color";   // color | ir
        private static int _step = 3;              // giảm mẫu ảnh màu: 1920/3 = 640
        private static float _gain = 1.0f;         // phơi sáng IR
        private static bool _useJpeg;
        private static long _jpegQuality = 70;
        private static int _sendEvery = 1;

        private static int _frameIndex;
        private static volatile bool _sending;     // không cho >1 frame bay cùng lúc
        private static byte[] _gray;               // đệm ảnh xám (IR)
        private static byte[] _bgra;               // đệm ảnh màu thô
        private static byte[] _frame;              // đệm gói gửi đi
        private static string _handJson = "null";

        private static async Task Main(string[] args)
        {
            foreach (var a in args)
            {
                if (a.StartsWith("--url=")) _url = a.Substring(6);
                else if (a.StartsWith("--source=")) _source = a.Substring(9).ToLowerInvariant();
                else if (a.StartsWith("--step=")) _step = Math.Max(1, int.Parse(a.Substring(7)));
                else if (a.StartsWith("--gain=")) _gain = float.Parse(a.Substring(7), System.Globalization.CultureInfo.InvariantCulture);
                else if (a.StartsWith("--every=")) _sendEvery = Math.Max(1, int.Parse(a.Substring(8)));
                else if (a == "--jpeg") _useJpeg = true;
                else if (a.StartsWith("--quality=")) _jpegQuality = long.Parse(a.Substring(10));
            }
            bool wantIr = _source == "ir";

            _sensor = KinectSensor.GetDefault();
            if (_sensor == null)
            {
                Console.WriteLine("KHONG tim thay Kinect. Cam Kinect v2 vao cong USB 3.0 va cai Kinect SDK 2.0.");
                return;
            }
            _sensor.Open();
            var types = (wantIr ? FrameSourceTypes.Infrared : FrameSourceTypes.Color) | FrameSourceTypes.Body;
            _reader = _sensor.OpenMultiSourceFrameReader(types);
            _reader.MultiSourceFrameArrived += OnFrame;
            Console.WriteLine("Kinect da mo (nguon = " + (wantIr ? "IR" : "COLOR") + "). Dang ket noi " + _url + " …");

            // Tự nối lại: app có thể khởi động sau bridge, hoặc restart giữa chừng.
            while (true)
            {
                if (_ws == null || _ws.State != WebSocketState.Open)
                {
                    try
                    {
                        _ws?.Dispose();
                        _ws = new ClientWebSocket();
                        await _ws.ConnectAsync(new Uri(_url), CancellationToken.None);
                        Console.WriteLine("Da noi app.");
                    }
                    catch (Exception e)
                    {
                        Console.WriteLine("Chua noi duoc (" + e.Message + ") — thu lai sau 2s.");
                        await Task.Delay(2000);
                    }
                }
                await Task.Delay(500);
            }
        }

        private static void OnFrame(object sender, MultiSourceFrameArrivedEventArgs e)
        {
            var multi = e.FrameReference.AcquireFrame();
            if (multi == null) return;

            ReadBodies(multi);

            _frameIndex++;
            if (_frameIndex % _sendEvery != 0) return;
            // Bỏ frame khi frame trước chưa gửi xong — thà rớt frame còn hơn dồn
            // hàng đợi rồi trễ cả giây.
            if (_sending || _ws == null || _ws.State != WebSocketState.Open) return;

            if (_source == "ir") SendInfrared(multi);
            else SendColor(multi);
        }

        // ------------------------------------------------------------- COLOR
        private static void SendColor(MultiSourceFrame multi)
        {
            using (var cf = multi.ColorFrameReference.AcquireFrame())
            {
                if (cf == null) return;
                var d = cf.FrameDescription;
                int sw = d.Width, sh = d.Height;       // 1920x1080
                int need = sw * sh * 4;
                if (_bgra == null || _bgra.Length != need) _bgra = new byte[need];
                cf.CopyConvertedFrameDataToArray(_bgra, ColorImageFormat.Bgra);

                // Giảm mẫu ngay tại đây. Gửi nguyên 1920x1080 là 8.3MB/frame —
                // vô nghĩa, vì MediaPipe co ảnh về cỡ nhỏ trước khi chạy, mà
                // 1 bàn tay ở 1-2m thì 640x360 đã thừa chi tiết.
                int w = sw / _step, h = sh / _step;
                int len = 10 + w * h * 3;
                if (_frame == null || _frame.Length != len) _frame = new byte[len];
                WriteHeader(_frame, w, h, 3);

                int o = 10;
                for (int y = 0; y < h; y++)
                {
                    int row = (y * _step) * sw * 4;
                    for (int x = 0; x < w; x++)
                    {
                        int i = row + (x * _step) * 4;   // BGRA
                        _frame[o++] = _bgra[i + 2];      // R
                        _frame[o++] = _bgra[i + 1];      // G
                        _frame[o++] = _bgra[i];          // B
                    }
                }
                Send(_frame, w, h, 3);
            }
        }

        // ---------------------------------------------------------------- IR
        private static void SendInfrared(MultiSourceFrame multi)
        {
            using (var ir = multi.InfraredFrameReference.AcquireFrame())
            {
                if (ir == null) return;
                var d = ir.FrameDescription;
                int w = d.Width, h = d.Height;
                if (_gray == null || _gray.Length != w * h) _gray = new byte[w * h];
                using (var buf = ir.LockImageBuffer())
                {
                    ToGrayscale(buf, w * h);
                }

                int len = 10 + w * h;
                if (_frame == null || _frame.Length != len) _frame = new byte[len];
                WriteHeader(_frame, w, h, 1);
                Buffer.BlockCopy(_gray, 0, _frame, 10, w * h);
                Send(_frame, w, h, 1);
            }
        }

        // ------------------------------------------------------------- gửi
        private static void WriteHeader(byte[] b, int w, int h, int channels)
        {
            b[0] = (byte)'D'; b[1] = (byte)'J'; b[2] = (byte)'I'; b[3] = (byte)'R';
            b[4] = (byte)(w & 0xFF); b[5] = (byte)(w >> 8);
            b[6] = (byte)(h & 0xFF); b[7] = (byte)(h >> 8);
            b[8] = (byte)channels;
            b[9] = 0; // dành chỗ
        }

        private static void Send(byte[] payload, int w, int h, int channels)
        {
            _sending = true;
            if (_useJpeg)
            {
                byte[] jpeg = EncodeJpeg(payload, 10, w, h, channels);
                string json = "{\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                              + ",\"ir\":\"" + Convert.ToBase64String(jpeg)
                              + "\",\"hand\":" + _handJson + "}";
                var bytes = Encoding.UTF8.GetBytes(json);
                _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None)
                   .ContinueWith(t => { _sending = false; });
            }
            else
            {
                _ws.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Binary, true, CancellationToken.None)
                   .ContinueWith(t => { _sending = false; });
            }
        }

        /// <summary>Chuẩn hoá ushort IR về 8-bit theo công thức của Kinect SDK.</summary>
        private static unsafe void ToGrayscale(KinectBuffer buf, int count)
        {
            ushort* src = (ushort*)buf.UnderlyingBuffer;
            for (int i = 0; i < count; i++)
            {
                float ratio = src[i] / IrSourceValueMaximum;
                ratio /= IrSceneValueAverage * IrSceneStandardDeviations;
                ratio *= _gain;
                ratio = Math.Min(IrOutputValueMaximum, Math.Max(IrOutputValueMinimum, ratio));
                _gray[i] = (byte)(ratio * 255f);
            }
        }

        /// <summary>Bàn tay phải của người gần nhất — để sẵn cho đường dự phòng.</summary>
        private static void ReadBodies(MultiSourceFrame multi)
        {
            using (var bf = multi.BodyFrameReference.AcquireFrame())
            {
                if (bf == null) return;
                var bodies = new Body[bf.BodyCount];
                bf.GetAndRefreshBodyData(bodies);
                Body best = null;
                float bestZ = float.MaxValue;
                foreach (var b in bodies)
                {
                    if (b == null || !b.IsTracked) continue;
                    float z = b.Joints[JointType.SpineMid].Position.Z;
                    if (z > 0 && z < bestZ) { bestZ = z; best = b; }
                }
                if (best == null) { _handJson = "null"; return; }

                var hand = best.Joints[JointType.HandRight].Position;
                var p = _sensor.CoordinateMapper.MapCameraPointToDepthSpace(hand);
                if (float.IsInfinity(p.X) || float.IsInfinity(p.Y)) { _handJson = "null"; return; }
                string state = best.HandRightState.ToString().ToLowerInvariant();
                _handJson = "{\"x\":" + (p.X / 512f).ToString("F4")
                          + ",\"y\":" + (p.Y / 424f).ToString("F4")
                          + ",\"z\":" + hand.Z.ToString("F3")
                          + ",\"state\":\"" + state + "\"}";
            }
        }

        private static byte[] EncodeJpeg(byte[] src, int offset, int w, int h, int channels)
        {
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                int stride = data.Stride;
                var row = new byte[stride];
                for (int y = 0; y < h; y++)
                {
                    int o = offset + y * w * channels;
                    for (int x = 0; x < w; x++)
                    {
                        // Bitmap 24bpp xếp theo BGR.
                        if (channels == 1)
                        {
                            byte v = src[o + x];
                            row[x * 3] = v; row[x * 3 + 1] = v; row[x * 3 + 2] = v;
                        }
                        else
                        {
                            row[x * 3] = src[o + x * 3 + 2];
                            row[x * 3 + 1] = src[o + x * 3 + 1];
                            row[x * 3 + 2] = src[o + x * 3];
                        }
                    }
                    Marshal.Copy(row, 0, data.Scan0 + y * stride, stride);
                }
                bmp.UnlockBits(data);

                var ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(Encoder.Quality, _jpegQuality);
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, GetJpegCodec(), ps);
                    return ms.ToArray();
                }
            }
        }

        private static ImageCodecInfo _jpegCodec;
        private static ImageCodecInfo GetJpegCodec()
        {
            if (_jpegCodec != null) return _jpegCodec;
            foreach (var c in ImageCodecInfo.GetImageEncoders())
                if (c.FormatID == ImageFormat.Jpeg.Guid) { _jpegCodec = c; break; }
            return _jpegCodec;
        }
    }
}
