# 双摄像头无线中继方案

2026-11-07 方案归档，源码审阅基线为 `aecf9f1a88a68d898c69ec67cb9b9a0629918f6a`。本目录保存方案与采购材料；固件、网页多路播放和自动切换仍需后续实现、实板验收。PDF 中描述的仓库状态对应文档生成时点。

- [方案 PDF（16 页）](双摄像头无线中继方案敲定与完整材料清单.pdf)
- [可编辑 TeX](双摄像头无线中继方案敲定与完整材料清单.tex)
- [原始需求副本](01_数据通信中继与三维联动平台需求书.md)
- [BOM 估算数据](bom_data.json)：每条数组依次为材料编号、数量、单价下限、单价上限，编号对应 PDF 的 M01–M08、A01–A13。

方案采用两套 ESP32-P4/C6＋SC2336、两台 GL-MT3000 中继和本地 MediaMTX，ESP8266 负责环境量、按钮与警示灯。每路 1280×720、25 fps 连续 H.264，以及单路径故障后 15 秒内重新出图，均为验收目标；尚无硬件实测结果。

全新采购控制 AP 时，材料估算 1741–2719 元，含预备费 1891–2969 元；复用合格 AP 时，含预备费 1771–2749 元。价格是规划估算，未取得商家报价，不含电脑、人工和运费。

## 重新编译

使用 XeLaTeX、TeX Live 和 Windows 中文字体。在本目录打开 PowerShell，编译中间文件放入被 Git 忽略的 `buffer/`：

```powershell
New-Item -ItemType Directory -Path buffer/compile, buffer/temp -Force | Out-Null
$env:TEMP = (Resolve-Path buffer/temp).Path
$env:TMP = $env:TEMP
Push-Location buffer/compile
try {
    xelatex -interaction=nonstopmode -halt-on-error -jobname=wireless_plan '../../双摄像头无线中继方案敲定与完整材料清单.tex'
    if ($LASTEXITCODE -ne 0) { throw '第一次编译失败' }
    xelatex -interaction=nonstopmode -halt-on-error -jobname=wireless_plan '../../双摄像头无线中继方案敲定与完整材料清单.tex'
    if ($LASTEXITCODE -ne 0) { throw '第二次编译失败' }
} finally {
    Pop-Location
}
Copy-Item -LiteralPath buffer/compile/wireless_plan.pdf -Destination '双摄像头无线中继方案敲定与完整材料清单.pdf' -Force
```

PDF 已完成页面渲染、文字与预算合计检查。原始资料下载快照、编译日志和页面检查图片留在本地结果目录的 `buffer/`，未纳入仓库；开源项目链接、核验版本和许可证说明见 PDF 第 12、16 页。
