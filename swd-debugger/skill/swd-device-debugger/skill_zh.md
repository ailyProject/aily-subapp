---
name: swd-device-debugger
description: "用于基于 probe-rs 调试 MCU SWD 流程，包括调试器发现、芯片附加、目标信息、复位策略、烧录、RTT/defmt 日志和 swd-debugger 子应用。"
---

# SWD 设备调试器

当用户需要通过 SWD 调试 MCU、排查 probe-rs 连接问题、自动化读取目标信息或烧录运行固件时，使用这个 skill。

## 首轮信息

1. 确认开发板、MCU 芯片名、调试器型号、SWD 接线、目标电压、NRST 是否连接、固件格式，以及是否使用 RTT/defmt。
2. 优先执行非破坏性检查：`version`、`list`、`info`。
3. 只有在用户提供芯片名且目标明确时，才继续 `attach`、`reset` 或 `run`。
4. 回答中保留 probe-rs 的关键原始错误文本。

## 调试路径

- `PROBE_RS_NOT_FOUND`：安装 probe-rs，或通过 `--probe-rs` 指定可执行文件。
- `NO_PROBE_FOUND`：检查 USB、调试器固件、驱动、权限，以及是否被其它调试软件占用。
- `PROBE_PERMISSION`：修复 WinUSB/libusb/udev 权限或驱动。
- `UNKNOWN_CHIP`：使用 probe-rs 支持的精确芯片名，或加入 CMSIS-Pack 目标。
- `TARGET_ATTACH_FAILED`：降低 SWD 速度，检查 SWDIO/SWCLK/GND/VTref，必要时尝试复位下连接。
- `SWD_LINK_FAULT`：检查目标供电、NRST、低功耗固件、SWD 引脚复用和板级焊接。
- `RTT_NOT_READY`：检查 RTT/defmt 初始化时机和早期崩溃。

## 安全边界

- 除非用户要求烧录或明确启用，不要执行写 flash 或擦除类操作。
- 推荐顺序是 `info` -> `attach` -> `run`。
- 复位下连接需要 NRST 接线，且并非所有调试器/目标板都支持。
- 推荐命令时明确说明是否会写入目标芯片。
