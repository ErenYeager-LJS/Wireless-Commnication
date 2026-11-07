# Windows 部署与排障

## 离线部署

交付电脑已安装 Node.js 24。联网准备阶段运行一次 `npm install` 和 `npm run build`，之后 `node_modules`、`dist` 和全部字体/脚本均在项目目录，断开互联网仍可运行。

演示启动：双击 `启动演示平台.cmd`。真实设备启动：双击 `启动真实设备平台.cmd`。停止使用 `停止平台.cmd`。日志位于 `logs/platform.log` 和 `logs/platform-error.log`，运行数据库位于 `data/relay-platform.db`。

## 防火墙

仅在“专用网络”放行 TCP 1883（设备 MQTT）和 TCP 8787（网页/图片）。不要向公网映射这两个端口。部署前必须修改 `DEVICE_TOKEN`。

## 排障顺序

1. 浏览器打不开：检查 `logs/platform-error.log`，确认 8787 未被占用。
2. 设备离线：确认 MQTT 地址、用户名、令牌和系统时间；检查 1883 连通性。
3. 中继上电但路径不亮：这是正确行为，必须收到终端上报的中继 `path` 和有效转发证据。
4. 灯已动作但页面超时：终端必须在动作完成后返回相同 `command_id` 的 ACK。
5. 画面停滞：检查帧的 `capturedAt`，旧帧不会被标成实时；确认上传令牌与 Content-Type。
6. 中继模式仍可绕行：关闭终端备用 Wi-Fi/网线，关闭 `relay-agent` 后复测，业务应中断。

## 数据备份

停止平台后备份 `data/relay-platform.db`、现场原始测试日志和验收表。数据库使用 WAL；运行中不要只复制单个 `.db` 文件。
