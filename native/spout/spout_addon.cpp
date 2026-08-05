// ============================================================================
// dj-spout — N-API addon: nhận shared D3D11 texture handle từ Electron OSR
// (useSharedTexture) và phát qua Spout (SpoutDX). Windows-only; non-Windows = stub.
//
// Điểm quan trọng:
//  - Laptop hybrid (Intel iGPU + RTX) → shared handle của Chromium CHỈ mở được
//    trên đúng adapter đã tạo ra nó. Ta dò lần lượt từng DXGI adapter, adapter
//    nào OpenSharedResource1 thành công thì lấy device đó cho SpoutDX.
//  - Chromium cấp texture có codedSize lớn hơn vùng ảnh thật (padding) → gửi
//    theo visibleRect (SendTexture có overload cắt vùng) để receiver không dính viền.
//  - Mọi lỗi ghi vào g_lastError, JS đọc qua lastError() để hiện lên UI.
// ============================================================================
#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <d3d11.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <map>
#include <string>
#include <cstdio>
#include <cstdarg>
#include "spoutsdk/SpoutDX.h"

struct Sender {
  spoutDX* spout = nullptr;
  ID3D11Device* device = nullptr;   // device trên adapter mở được handle
  ID3D11Device1* device1 = nullptr;
  int adapter = -1;
};

static std::map<std::string, Sender> g_senders;
static std::string g_lastError;

static void SetErr(const char* fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  g_lastError = buf;
}

// Dò adapter: tạo D3D11 device trên từng adapter, thử mở shared handle.
static bool PickDeviceForHandle(HANDLE h, ID3D11Device** outDev, ID3D11Device1** outDev1, int* outAdapter) {
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))) || !factory) {
    SetErr("CreateDXGIFactory1 that bai");
    return false;
  }

  int tried = 0;
  IDXGIAdapter1* ad = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &ad) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc = {};
    ad->GetDesc1(&desc);
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) { ad->Release(); ad = nullptr; continue; }
    tried++;

    ID3D11Device* dev = nullptr;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(ad, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                   D3D11_SDK_VERSION, &dev, &fl, nullptr);
    if (SUCCEEDED(hr) && dev) {
      ID3D11Device1* dev1 = nullptr;
      if (SUCCEEDED(dev->QueryInterface(__uuidof(ID3D11Device1), reinterpret_cast<void**>(&dev1))) && dev1) {
        ID3D11Texture2D* probe = nullptr;
        if (SUCCEEDED(dev1->OpenSharedResource1(h, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&probe))) && probe) {
          probe->Release();
          *outDev = dev;
          *outDev1 = dev1;
          *outAdapter = static_cast<int>(i);
          ad->Release();
          factory->Release();
          return true;
        }
        dev1->Release();
      }
      dev->Release();
    }
    ad->Release();
    ad = nullptr;
  }

  factory->Release();
  SetErr("khong adapter nao mo duoc shared handle (da thu %d GPU)", tried);
  return false;
}

// Không có shared handle để dò thì chọn GPU rời: adapter nhiều VRAM nhất.
// (Laptop hybrid: Intel iGPU thường ~128MB shared, RTX vài GB.)
static bool CreateDeviceOnBestAdapter(ID3D11Device** outDev, int* outAdapter) {
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))) || !factory) {
    SetErr("CreateDXGIFactory1 that bai");
    return false;
  }
  int bestIdx = -1;
  SIZE_T bestVram = 0;
  IDXGIAdapter1* ad = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &ad) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc = {};
    ad->GetDesc1(&desc);
    if (!(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) && desc.DedicatedVideoMemory >= bestVram) {
      bestVram = desc.DedicatedVideoMemory;
      bestIdx = static_cast<int>(i);
    }
    ad->Release();
    ad = nullptr;
  }
  bool ok = false;
  if (bestIdx >= 0 && SUCCEEDED(factory->EnumAdapters1(static_cast<UINT>(bestIdx), &ad)) && ad) {
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    ok = SUCCEEDED(D3D11CreateDevice(ad, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                     D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                     D3D11_SDK_VERSION, outDev, &fl, nullptr)) && *outDev;
    if (ok) *outAdapter = bestIdx;
    ad->Release();
  }
  factory->Release();
  if (!ok) SetErr("khong tao duoc D3D11 device tren adapter nao");
  return ok;
}

static Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  Sender& s = g_senders[name];
  if (!s.spout) {
    s.spout = new spoutDX();
    s.spout->SetSenderName(name.c_str());
  }
  // Device tạo trễ ở frame đầu — cần shared handle mới biết adapter nào đúng.
  return Napi::Boolean::New(env, true);
}

// sendImage(name, bgraBuffer, w, h) — ĐƯỜNG DỰ PHÒNG khi Chromium không cấp
// shared texture: upload pixel BGRA từ CPU lên texture Spout (UpdateSubresource).
// Tốn 1 lần upload PCIe mỗi frame, nhưng vẫn nhẹ hơn NDI nhiều (không nén).
static Napi::Value SendImage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  auto it = g_senders.find(name);
  if (it == g_senders.end()) {
    SetErr("sender \"%s\" chua open", name.c_str());
    return Napi::Boolean::New(env, false);
  }
  Sender& s = it->second;

  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  UINT w = info[2].As<Napi::Number>().Uint32Value();
  UINT h = info[3].As<Napi::Number>().Uint32Value();
  if (!w || !h || buf.Length() < static_cast<size_t>(w) * h * 4) {
    SetErr("buffer %u byte khong du cho %ux%u BGRA", static_cast<unsigned>(buf.Length()), w, h);
    return Napi::Boolean::New(env, false);
  }

  if (!s.device) {
    if (!CreateDeviceOnBestAdapter(&s.device, &s.adapter)) return Napi::Boolean::New(env, false);
    if (!s.spout->OpenDirectX11(s.device)) {
      SetErr("OpenDirectX11 that bai tren adapter %d", s.adapter);
      s.device->Release();
      s.device = nullptr;
      return Napi::Boolean::New(env, false);
    }
    s.spout->SetSenderName(name.c_str());
    g_lastError.clear();
  }

  bool ok = s.spout->SendImage(buf.Data(), w, h, w * 4);
  if (!ok) SetErr("SendImage that bai (%ux%u)", w, h);
  return Napi::Boolean::New(env, ok);
}

// sendHandle(name, handleBuffer, x, y, w, h)
static Napi::Value SendHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name = info[0].As<Napi::String>().Utf8Value();
  auto it = g_senders.find(name);
  if (it == g_senders.end()) {
    SetErr("sender \"%s\" chua open", name.c_str());
    return Napi::Boolean::New(env, false);
  }
  Sender& s = it->second;

  Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
  if (buf.Length() < sizeof(HANDLE)) {
    SetErr("sharedTextureHandle sai kich thuoc (%u byte)", static_cast<unsigned>(buf.Length()));
    return Napi::Boolean::New(env, false);
  }
  HANDLE h = *reinterpret_cast<HANDLE*>(buf.Data());
  if (!h) {
    SetErr("sharedTextureHandle rong");
    return Napi::Boolean::New(env, false);
  }

  // Frame đầu: chọn adapter + gắn device vào SpoutDX.
  if (!s.device1) {
    if (!PickDeviceForHandle(h, &s.device, &s.device1, &s.adapter)) return Napi::Boolean::New(env, false);
    if (!s.spout->OpenDirectX11(s.device)) {
      SetErr("OpenDirectX11 that bai tren adapter %d", s.adapter);
      s.device1->Release(); s.device1 = nullptr;
      s.device->Release();  s.device = nullptr;
      return Napi::Boolean::New(env, false);
    }
    s.spout->SetSenderName(name.c_str());
    g_lastError.clear();
  }

  ID3D11Texture2D* tex = nullptr;
  HRESULT hr = s.device1->OpenSharedResource1(h, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&tex));
  if (FAILED(hr) || !tex) {
    SetErr("OpenSharedResource1 hr=0x%08lX", static_cast<unsigned long>(hr));
    return Napi::Boolean::New(env, false);
  }

  D3D11_TEXTURE2D_DESC d = {};
  tex->GetDesc(&d);

  // Vùng ảnh thật (visibleRect) — texture Chromium có thể lớn hơn do padding.
  UINT rx = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().Uint32Value() : 0;
  UINT ry = info.Length() > 3 && info[3].IsNumber() ? info[3].As<Napi::Number>().Uint32Value() : 0;
  UINT rw = info.Length() > 4 && info[4].IsNumber() ? info[4].As<Napi::Number>().Uint32Value() : 0;
  UINT rh = info.Length() > 5 && info[5].IsNumber() ? info[5].As<Napi::Number>().Uint32Value() : 0;
  if (rw == 0 || rx + rw > d.Width)  { rx = 0; rw = d.Width; }
  if (rh == 0 || ry + rh > d.Height) { ry = 0; rh = d.Height; }

  // Keyed mutex (nếu Electron dùng) — không lấy được thì BỎ frame, không gửi rác.
  IDXGIKeyedMutex* km = nullptr;
  if (SUCCEEDED(tex->QueryInterface(__uuidof(IDXGIKeyedMutex), reinterpret_cast<void**>(&km))) && km) {
    if (FAILED(km->AcquireSync(0, 16))) {
      km->Release();
      tex->Release();
      return Napi::Boolean::New(env, false); // frame bận, thử frame sau
    }
  }

  bool ok = (rx || ry || rw != d.Width || rh != d.Height)
              ? s.spout->SendTexture(tex, rx, ry, rw, rh)
              : s.spout->SendTexture(tex);
  if (!ok) SetErr("SendTexture that bai (%ux%u fmt=%d)", rw, rh, static_cast<int>(d.Format));

  if (km) { km->ReleaseSync(0); km->Release(); }
  tex->Release();
  return Napi::Boolean::New(env, ok);
}

static Napi::Value Close(const Napi::CallbackInfo& info) {
  std::string name = info[0].As<Napi::String>().Utf8Value();
  auto it = g_senders.find(name);
  if (it != g_senders.end()) {
    Sender& s = it->second;
    if (s.spout) { s.spout->ReleaseSender(); s.spout->CloseDirectX11(); delete s.spout; }
    if (s.device1) s.device1->Release();
    if (s.device) s.device->Release();
    g_senders.erase(it);
  }
  return info.Env().Undefined();
}

static Napi::Value Available(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

static Napi::Value LastError(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), g_lastError);
}

// Adapter đang dùng cho một sender (-1 = chưa gửi frame nào) — để log/UI.
static Napi::Value AdapterOf(const Napi::CallbackInfo& info) {
  std::string name = info[0].As<Napi::String>().Utf8Value();
  auto it = g_senders.find(name);
  return Napi::Number::New(info.Env(), it == g_senders.end() ? -1 : it->second.adapter);
}

#else // ---------------- non-Windows stub ----------------
static Napi::Value Open(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), false); }
static Napi::Value SendHandle(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), false); }
static Napi::Value SendImage(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), false); }
static Napi::Value Close(const Napi::CallbackInfo& info) { return info.Env().Undefined(); }
static Napi::Value Available(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), false); }
static Napi::Value LastError(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), "chi chay tren Windows"); }
static Napi::Value AdapterOf(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), -1); }
#endif

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("sendHandle", Napi::Function::New(env, SendHandle));
  exports.Set("sendImage", Napi::Function::New(env, SendImage));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("available", Napi::Function::New(env, Available));
  exports.Set("lastError", Napi::Function::New(env, LastError));
  exports.Set("adapterOf", Napi::Function::New(env, AdapterOf));
  return exports;
}

NODE_API_MODULE(djspout, Init)
