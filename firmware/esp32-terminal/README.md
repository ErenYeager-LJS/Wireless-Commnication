# ESP32 业务终端固件

目标板默认为 `ESP32 DevKit V1 / ESP32-WROOM-32`。代码提供真实状态、DHT22、告警按钮、警示灯、直连/中继 Wi-Fi 切换、10 Hz 探测、RTT/丢包统计、命令去重和执行回执。

1. 将 `include/secrets.h.example` 复制为 `include/secrets.h` 并填写两个 Wi-Fi、两个 MQTT 地址和令牌。
2. 短按 GPIO27 告警；长按 2.5 秒在直连与中继网络间切换。
3. GPIO26 只能直接驱动普通 LED。5V/12V 警示灯必须通过逻辑电平 MOSFET 模块，不能直接接 ESP32。
4. GPIO25 接 DHT22 DATA，DHT22 模块使用 3.3V 供电。

当前电脑原先没有 Arduino CLI、ESP-IDF 或 PlatformIO。本项目内含固定版本 PlatformIO 配置，后续构建环境安装在项目目录内，不污染系统环境。
