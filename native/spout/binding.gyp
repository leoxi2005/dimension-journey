{
  "targets": [
    {
      "target_name": "djspout",
      "sources": ["spout_addon.cpp"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "spoutsdk/SpoutDX.cpp",
            "spoutsdk/SpoutDirectX.cpp",
            "spoutsdk/SpoutFrameCount.cpp",
            "spoutsdk/SpoutSenderNames.cpp",
            "spoutsdk/SpoutSharedMemory.cpp",
            "spoutsdk/SpoutCopy.cpp",
            "spoutsdk/SpoutUtils.cpp"
          ],
          "include_dirs": ["spoutsdk"],
          "libraries": ["d3d11.lib", "dxgi.lib", "Advapi32.lib", "Shell32.lib", "User32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}
