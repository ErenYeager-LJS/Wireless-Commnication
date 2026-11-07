# AI Thinker ESP32-CAM 图像终端

该固件每秒采集一张 640×480 JPEG，通过中继节点的 8787 TCP 转发上传到平台，并由平台显示实际采集时间。复制 `include/secrets.h.example` 为 `include/secrets.h` 后填写 Wi-Fi 和令牌。

烧录时 USB-TTL 使用 5V 为板载稳压器供电，TX/RX 交叉连接，GPIO0 接 GND 后复位进入下载模式；烧录完成后断开 GPIO0 与 GND 再复位。不要把 USB-TTL 的 5V 接到 ESP32 的 3V3 引脚。
