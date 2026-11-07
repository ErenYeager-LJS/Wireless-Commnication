# GL-MT3000 / OpenWrt 中继部署

建议上游使用 5 GHz Wi-Fi 或网线接控制网段 `192.168.50.0/24`，下游 2.4 GHz AP 使用 `192.168.60.0/24`，SSID 为 `RELAY_TERM_2G`。ESP32 只连接下游 AP。

设备联网准备阶段：

```sh
opkg update
opkg install node
```

将 `device-agents/relay-agent.mjs` 上传为 `/root/relay-agent.mjs`，将 `device-agents/openwrt-relay.init` 上传为 `/etc/init.d/relay-platform`，修改其中 `DEVICE_TOKEN` 后执行：

```sh
chmod +x /etc/init.d/relay-platform
/etc/init.d/relay-platform enable
/etc/init.d/relay-platform start
logread -e relay-platform
```

代理同时转发 MQTT 1883 和图像 HTTP 8787，并统计双向包数/字节数。中继验收时执行 `/etc/init.d/relay-platform stop`，业务应立即中断；若仍可通信，说明存在绕行链路，不能验收。
