# OV5647 本地接收端

此目录移植自现有 `esp_image_relay_demo` 的单路 OV5647 接收代码。它接收 P4 的硬件 H.264 图像，在电脑解码为 MJPEG，并运行本地 YOLOX 人物检测；Wi-Fi 控制由 `Soft/PC/wireless.py` 发送给现有固件。

从仓库根目录运行 `启动OV高清中继平台.cmd` 即可。脚本会检查 Python 依赖与人物模型，复用兼容的 8080 接收程序，或者启动本目录中的程序。它不会抢占其他程序的 8080 端口。需要指定 Python 时，在 PowerShell 先设置：

```powershell
$env:ESP_PYTHON = 'D:/Python312/python.exe'
powershell -ExecutionPolicy Bypass -File scripts/Start-Platform.ps1 -Mode esp32
```

接收端依赖 `av`、`opencv-python`、`onnxruntime` 及其 NumPy 依赖，见 `Soft/PC/requirements.txt`。建议使用 Python 3.12；全新电脑的依赖安装、模型下载需要网络。

人物模型文件 `receiver/models/person-yolox.onnx` 不提交到 Git。首次启动会通过固定版本地址下载并核对 SHA-256；当前电脑已有可用模型。若下载失败，可在本目录手动执行：

```powershell
python -B Soft/tools/setup_person_detection.py --mirror
```

也可以去掉 `--mirror` 使用原站。模型来源、摘要和许可证在 `receiver/models/`。检测过程中不向外网发送图像；衣物、遮挡、暗光可能导致误检、漏检，人数仅供演示。

| 端口 | 用途 |
| --- | --- |
| TCP 8080 | ESP 图像输入、接收状态、MJPEG、控制 API |
| UDP 8081 | 局域网发现、设备心跳、无线控制 |
| TCP 8787 | 根目录 Node 服务提供的新 UI，仅监听本机 |

接收端需要允许 Windows 防火墙中的专用网络入站。设备已使用原项目固件，本次没有更改或重新烧录。Wi-Fi 密码与私有固件配置不包含在此目录；重新烧录时仍使用原硬件工程。

`source-manifest.json` 记录了移植时 16 个源文件的 SHA-256，便于与原工程比对。静态页面保留用于 8080 接收诊断；新界面入口是 8787。运行日志在仓库 `buffer/logs/`，模型下载中间文件在本目录 `Soft/buffer/temp/`，均由 Git 忽略。
