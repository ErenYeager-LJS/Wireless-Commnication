# 麟盾数据通信中继与三维联动平台

这是需求书对应的可运行工程样机软件。平台在一台 Windows 控制电脑上离线运行，集成本地 MQTT Broker、设备接入、链路指标、命令回执、SQLite 事件存储、WebSocket 和 Three.js 三维大屏。

## 当前交付状态

- 已完成：三维园区、楼层抽出/透明化、设备点选、实际路径显示、实时指标、事件记录、直连/中继人工选择、3 秒命令超时、灯控回执、现场帧上传、本地 MQTT、SQLite、Windows 一键启停、演示模拟器、ESP32 固件与 OpenWrt 中继代理。
- 已完成：六建筑园区、道路/停车/景观、动态无人机巡逻；普通 ESP32 终端固件与 AI Thinker ESP32-CAM 固件均已用目标工具链编译通过。
- 已验证：TypeScript 检查、自动测试、生产构建、依赖安全审计、本机 API 与 WebSocket 联动、两套 ESP32 目标固件编译、桌面与移动端三维画布和无人机运动。
- 待现场完成：确认现有 ESP32 型号、购买并连接清单中的外设/中继、写入实际 Wi-Fi 后烧录、双网段配置、外壳尺寸复核/打印、60 秒对比测试、1 小时稳定性测试和实物验收。软件不会把模拟结果写成实测结果。

## 快速启动

双击 `启动演示平台.cmd`，浏览器访问 `http://localhost:8787`。演示模式会显示黄色“模拟数据”标识，可注入稳定、退化、断链和告警场景。

接入真实设备前：

1. 将 `.env.example` 复制为 `.env`，修改 `DEVICE_TOKEN`。
2. 按 `docs/01-网络拓扑与首日冻结.md` 配置双网段。
3. 在控制电脑双击 `启动真实设备平台.cmd`。
4. 在终端和中继节点启动 `device-agents` 中对应程序。

硬件采购、接线和两种 ESP32 板型路线见 `docs/07-硬件清单与接线.md`。OpenWrt 中继部署见 `docs/08-OpenWrt中继部署.md`。

## 开发命令

```powershell
npm install
npm run dev
npm test
npm run check
npm run build
```

开发界面为 `http://localhost:5173`，生产界面为 `http://localhost:8787`，MQTT 为 TCP `1883`。

## 目录

```text
server/          本地服务、MQTT、SQLite、状态机和模拟器
src/             React + Three.js 大屏
device-agents/   Linux 终端与真实 TCP 中继程序
config/          网络配置样例
enclosure/       可参数化外壳源文件
docs/            拓扑、接口、部署、BOM、验收与演示材料
scripts/         Windows 启停脚本
tests/           自动测试
data/            运行数据库和现场帧（运行时生成）
```

## 数据真实性

`source` 字段只有 `measured`、`simulated`、`historical` 三种。真实模式不启动模拟器；路径只有收到带 `path` 和转发计数的指标后才点亮。MQTT 消息已送达不等于设备执行成功，控制按钮必须等到终端按 `command_id` 返回 ACK 才显示 `executed`。
