# FFS 管理器

FFS 管理器是面向 ESP MCU 的 Flash 文件系统管理子应用，用于读取设备信息、解析分区表、导出或恢复分区镜像，并浏览和编辑 SPIFFS、LittleFS、FATFS 分区中的文件。它适合调试固件文件系统、网页资源分区、配置文件分区和 flash 读写流程。

## 适用场景

- 枚举串口并连接 ESP 设备 bootloader。
- 读取芯片信息、MAC、Flash 大小和分区表。
- 识别 SPIFFS、LittleFS、FATFS 等文件系统分区。
- 导出分区镜像作为备份，或恢复已有镜像到指定分区。
- 在 UI 中浏览文件、上传、下载、重命名、删除和新建目录。
- 擦除指定分区，验证分区布局和文件系统格式是否正确。

## 运行方式

在本仓库根目录安装该子应用依赖：

```powershell
npm install --prefix ffs-manager
```

本地启动浏览器 UI：

```powershell
node ffs-manager/index.js serve --host 127.0.0.1 --port 0
```

`serve` 模式会输出一行 `ready` JSON，其中 `url` 可直接打开。集成到 IDE 时，宿主会负责启动子进程、加载 iframe、传入语言和主题，并在需要时协调串口占用。

查看 CLI 帮助和状态：

```powershell
node ffs-manager/index.js --help
node ffs-manager/index.js status
```

构建分发包：

```powershell
npm run build -- ffs-manager
```

## 界面用法

1. 选择串口和波特率，刷新设备信息。
2. 读取分区表，确认目标分区的 label、offset、size 和文件系统类型。
3. 选择 SPIFFS、LittleFS 或 FATFS 分区后加载文件列表。
4. 通过文件表上传、下载、重命名、删除文件；LittleFS 和 FATFS 支持目录操作。
5. 修改后根据界面提示写回分区。
6. 执行恢复镜像、格式化或擦除前，先导出分区镜像作为备份。

## CLI 用法

CLI 适合做设备信息、分区表、镜像读取和擦除的自动化检查：

```powershell
node ffs-manager/index.js ports
node ffs-manager/index.js info --port COM3 --baud 921600
node ffs-manager/index.js partitions --port COM3 --baud 921600
node ffs-manager/index.js read --port COM3 --offset 0x290000 --size 0x170000 --baud 921600
node ffs-manager/index.js erase --port COM3 --offset 0x290000 --size 0x170000 --baud 921600
```

所有非 help 命令都会输出一个 JSON 对象。分区写入和镜像恢复由 UI/RPC 流程提供，执行前应确认 offset 和 size。

## 目录结构

- `index.js`：根据参数进入 `rpc`、`serve` 或 CLI 模式。
- `core.js`：封装 `serialport`、`esptool-js`、Flash 读写擦除、分区探测和解析。
- `serial-port-adapter.js`：把 Node 串口适配为 esptool 需要的 transport。
- `usb-bridge.js`：处理特定 USB bridge 的波特率行为。
- `server.js`：提供本地 HTTP 服务、WASM 资源、WebSocket RPC、token 校验和关闭接口。
- `cli.js`：提供串口、设备信息、分区表、读取和擦除命令。
- `ui/`：文件系统管理界面，以及 SPIFFS、LittleFS、FATFS 镜像操作 WASM。
- `i18n/`：多语言文案。
- `skill/`：AI 调试工作流说明。

## 注意事项

- 擦除、恢复镜像和写回分区都是高风险操作，执行前必须确认分区 offset、size、label 和备份状态。
- SPIFFS、LittleFS、FATFS 的目录和文件名限制不同；工具内置文件名长度检查。
- 串口可能被串口监视器或其他工具占用，操作前需要释放串口。
- Bootloader 连接失败时优先检查线缆、电源、驱动、BOOT/RESET 时序和波特率。
