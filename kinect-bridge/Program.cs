// ============================================================================
// KinectBridge — đọc Kinect v2 rồi đẩy sang app DIMENSION JOURNEY qua WebSocket.
//
// VÌ SAO CẦN: Kinect v2 không hiện ra như webcam UVC, bắt buộc đi qua Kinect SDK
// 2.0 (COM/.NET, chỉ Windows). Nhét SDK đó vào Electron bằng native addon là
// đường dài và dễ vỡ; tách ra một tiến trình nhỏ thì đơn giản và tự khởi động
// lại được nếu chết.
//
// GỬI CÁI GÌ: ảnh HỒNG NGOẠI 512×424 + hand state của body tracking.
// Mặc định gửi NHỊ PHÂN THÔ ('DJIR' + w + h + byte xám): không nén, không base64.
// Trên localhost chỉ 6.5MB/s, rẻ hơn nhiều so với nén JPEG một đầu rồi giải nén
// đầu kia — mà độ trễ mới là thứ đắt nhất trong chuỗi tương tác này. Dùng --jpeg
// nếu cần gửi qua mạng thật.
// Ảnh IR mới là thứ đáng giá: phòng chiếu tối om thì webcam RGB mù hoàn toàn,
// còn Kinect tự rọi hồng ngoại nên vẫn thấy rõ bàn tay. App chạy MediaPipe
// HandLandmarker TRÊN ảnh IR đó — vẫn có đủ 21 điểm để bắt cử chỉ chụm ngón,
// thứ mà hand state thô của Kinect (open/closed/lasso) không làm nổi.
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
        private static long _jpegQuality = 70;
        private static bool _useJpeg;
        private static float _gain = 1.0f;   // chỉnh phơi sáng IR: tay quá trắng thì hạ
        private static int _sendEvery = 1;         // 1 = mọi frame (30fps), 2 = 15fps
        private static int _frameIndex;
        private static volatile bool _sending;     // không cho >1 frame bay cùng lúc
        private static byte[] _pixels;
        private static byte[] _frame;
        private static string _handJson = "null";

        private static async Task Main(string[] args)
        {
            foreach (var a in args)
            {
                if (a.StartsWith("--url=")) _url = a.Substring(6);
                else if (a.StartsWith("--quality=")) _jpegQuality = long.Parse(a.Substring(10));
                else if (a.StartsWith("--every=")) _sendEvery = Math.Max(1, int.Parse(a.Substring(8)));
                else if (a == "--jpeg") _useJpeg = true;
                else if (a.StartsWith("--gain=")) _gain = float.Parse(a.Substring(7), System.Globalization.CultureInfo.InvariantCulture);
            }

            _sensor = KinectSensor.GetDefault();
            if (_sensor == null)
            {
                Console.WriteLine("KHONG tim thay Kinect. Cam Kinect v2 vao cong USB 3.0 va cai Kinect SDK 2.0.");
                return;
            }
            _sensor.Open();
            _reader = _sensor.OpenMultiSourceFrameReader(FrameSourceTypes.Infrared | FrameSourceTypes.Body);
            _reader.MultiSourceFrameArrived += OnFrame;
            Console.WriteLine("Kinect da mo. Dang ket noi " + _url + " …");

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

            using (var ir = multi.InfraredFrameReference.AcquireFrame())
            {
                if (ir == null) return;
                _frameIndex++;
                if (_frameIndex % _sendEvery != 0) return;
                // Bỏ frame khi frame trước chưa gửi xong — thà rớt frame còn hơn
                // dồn hàng đợi rồi trễ cả giây.
                if (_sending || _ws == null || _ws.State != WebSocketState.Open) return;

                var desc = ir.FrameDescription;
                int w = desc.Width, h = desc.Height;
                if (_pixels == null || _pixels.Length != w * h) _pixels = new byte[w * h];

                using (var buf = ir.LockImageBuffer())
                {
                    ToGrayscale(buf, w * h);
                }

                _sending = true;
                if (_useJpeg)
                {
                    byte[] jpeg = EncodeJpeg(_pixels, w, h);
                    string json = "{\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                                  + ",\"ir\":\"" + Convert.ToBase64String(jpeg)
                                  + "\",\"hand\":" + _handJson + "}";
                    var bytes = Encoding.UTF8.GetBytes(json);
                    _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None)
                       .ContinueWith(t => { _sending = false; });
                }
                else
                {
                    // 'DJIR' + w:uint16 LE + h:uint16 LE + w*h byte xám
                    int len = 8 + w * h;
                    if (_frame == null || _frame.Length != len) _frame = new byte[len];
                    _frame[0] = (byte)'D'; _frame[1] = (byte)'J'; _frame[2] = (byte)'I'; _frame[3] = (byte)'R';
                    _frame[4] = (byte)(w & 0xFF); _frame[5] = (byte)(w >> 8);
                    _frame[6] = (byte)(h & 0xFF); _frame[7] = (byte)(h >> 8);
                    Buffer.BlockCopy(_pixels, 0, _frame, 8, w * h);
                    _ws.SendAsync(new ArraySegment<byte>(_frame), WebSocketMessageType.Binary, true, CancellationToken.None)
                       .ContinueWith(t => { _sending = false; });
                }
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
                _pixels[i] = (byte)(ratio * 255f);
            }
        }

        /// <summary>Bàn tay phải của người gần nhất — dữ liệu dự phòng khi MediaPipe mất dấu.</summary>
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

        private static byte[] EncodeJpeg(byte[] gray, int w, int h)
        {
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                var rect = new Rectangle(0, 0, w, h);
                var data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                int stride = data.Stride;
                var row = new byte[stride];
                for (int y = 0; y < h; y++)
                {
                    int o = y * w;
                    for (int x = 0; x < w; x++)
                    {
                        byte v = gray[o + x];
                        row[x * 3] = v; row[x * 3 + 1] = v; row[x * 3 + 2] = v;
                    }
                    Marshal.Copy(row, 0, data.Scan0 + y * stride, stride);
                }
                bmp.UnlockBits(data);

                var codec = GetJpegCodec();
                var ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(Encoder.Quality, _jpegQuality);
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, codec, ps);
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
