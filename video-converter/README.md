# Aily Video Converter

`video-converter` 是 Aily Blockly / Aily Chat AI IDE 的独立子应用，用于把 JPG、PNG、WebP、GIF 图片和 MP4 视频转换为可由嵌入式显示库顺序播放的 AILY 帧文件。取模、预览和导出都在浏览器中完成；Node 子进程只负责子应用生命周期、静态资源、国际化资源和宿主通信，不接收媒体二进制数据。

## 功能

- 输入：`.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.mp4`。
- 输出像素格式：MONO1 XBM、RGB565 小端序、RGB332。
- 可配置输出宽高、分数 FPS、最大帧数、循环播放标志，以及 MONO 阈值、Floyd-Steinberg 抖动和反相。
- 转换完成后从实际导出缓冲区反解预览，可直接检查 RGB565 字节序和 XBM 位序。
- 优先使用浏览器 `showSaveFilePicker()` 导出；不可用时自动回退到 Blob 下载。
- 参数草稿保存在浏览器 `localStorage` 中，源文件和转换结果不会持久化。

静态图片通常生成一帧；GIF 可以保留动画帧。后缀按输入类别和像素格式确定：

| 像素格式 | `pixelFormat` | 图片后缀（包括 GIF） | MP4 后缀 | 单帧大小 |
| --- | ---: | --- | --- | --- |
| RGB565，小端序 | 1 | `.rgb565` | `.rgb565v` | `width * height * 2` |
| RGB332 | 2 | `.rgb332` | `.rgb332v` | `width * height` |
| MONO1，水平 XBM 位序 | 3 | `.mono` | `.monov` | `ceil(width / 8) * height` |

MONO 每行独立打包，最左侧像素写入当前字节的 bit 0，适合 U8g2/XBM 播放路径。

## AILY 文件格式

文件由固定 40 字节头和连续定长帧组成：

```text
40-byte AilyVideoHeader
frame 0
frame 1
frame 2
...
```

所有多字节整数均为小端序。版本 1 的文件头如下：

| 偏移 | 大小 | 字段 | 含义 |
| ---: | ---: | --- | --- |
| 0 | 4 | `magic` | ASCII `AILY` |
| 4 | 1 | `version` | 当前为 `1` |
| 5 | 1 | `headerSize` | 当前为 `40` |
| 6 | 1 | `pixelFormat` | `1` RGB565 LE、`2` RGB332、`3` MONO1 XBM |
| 7 | 1 | `flags` | bit 0 为建议循环播放，其余位保留 |
| 8 | 2 | `width` | 输出宽度 |
| 10 | 2 | `height` | 输出高度 |
| 12 | 4 | `fpsNumerator` | FPS 分子 |
| 16 | 4 | `fpsDenominator` | FPS 分母 |
| 20 | 4 | `frameCount` | 总帧数 |
| 24 | 4 | `frameSize` | 单帧字节数 |
| 28 | 4 | `dataOffset` | 帧数据起始位置，当前为 `40` |
| 32 | 4 | `dataSize` | `frameSize * frameCount` |
| 36 | 4 | `reserved` | 当前为 `0` |

播放器应校验 magic、版本、头长度、数据偏移、像素格式对应的单帧大小，以及实际文件长度是否至少为 `dataOffset + dataSize`。帧间隔可按下式计算：

```cpp
uint32_t frameIntervalUs =
    1000000ULL * header.fpsDenominator / header.fpsNumerator;
```

## 运行与构建

以下命令从 `D:\Git\aily-project\aily-subapp` 执行：

```powershell
npm install --prefix video-converter
npm install --prefix video-converter/ui
npm run build:ui --prefix video-converter

node video-converter/index.js --help
node video-converter/index.js status
node video-converter/index.js format-info
node video-converter/index.js serve --host 127.0.0.1 --port 0
```

`serve --port 0` 会在 stdout 输出一行包含实际端口、token 和 PID 的就绪 JSON。宿主使用 token 连接 `/ws`，并通过带 token 的 `/api/shutdown` 结束子进程。

也可以使用仓库根脚本：

```powershell
npm run dev -- video-converter --open
npm run build -- video-converter
```

`npm run build -- video-converter` 会生成可分发目录 `dist/video-converter/`；Angular UI 位于 `dist/video-converter/ui/`。CLI 的 `status` 和 `format-info` 只报告运行状态与格式信息，媒体转换必须在浏览器 UI 中进行。

## 浏览器与内存边界

- 图片解码依赖 WebCodecs `ImageDecoder`，MP4 解码依赖 WebCodecs `VideoDecoder`、`EncodedVideoChunk` 和浏览器对文件内视频编码的支持。能读取 MP4 元数据并不代表浏览器一定支持其中的 H.264、HEVC、AV1 或 VPx 编码。
- 转换在模块 Worker 中运行，并使用 `OffscreenCanvas` 缩放和取像素；不具备这些 API 的浏览器会给出明确错误。
- UI 拒绝超过 512 MiB 的源文件；生成文件预算为 256 MiB，最大尺寸为 4096 × 4096，最大帧数为 10000，目标 FPS 上限为 240。若预计输出超过预算，Worker 会自动降低实际最大帧数，单帧本身超过预算则直接失败。
- 这些数值是文件预算，不是峰值 RAM 保证。当前实现会在浏览器内存中持有源文件 `ArrayBuffer`、MP4 样本、打包帧数组和最终文件，解码器还会占用额外内存。因此在内存有限的机器上应主动降低输出尺寸和最大帧数。
- 文件选择、取模结果和导出字节均留在浏览器侧，不通过 WebSocket 或 Penpal 发送给宿主。

## 长 GOP MP4 约束

WebCodecs 在 `VideoDecoder.configure()` 或 `flush()` 后要求首次提交的编码块是关键帧。MP4 解码实现必须从轨道开头的同步样本开始，按 DTS 解码顺序连续提交 `key`/`delta` 样本；不能为了目标 FPS 直接跳过前导样本，也不能从任意 delta 帧开始。否则长 GOP H.264 文件会触发：

```text
Failed to execute 'decode' on 'VideoDecoder': A key frame is required after configure() or flush().
```

当前 Worker 保留完整的解码依赖链，只在解码输出阶段按目标 FPS 采样，并通过 `decodeQueueSize` 限流。回归样本位于 `test/fixtures/long-gop-h264.mp4.b64`；`mp4-decode-scheduler.spec.ts` 会实际解析该素材，验证超过 64 个 sample 时只做队列背压，且 `flush()` 只在最后一个 delta sample 之后执行一次。

## 目录结构

- `index.js` / `server.js` / `core.js` / `cli.js`：子应用生命周期、服务和诊断命令。
- `ui/src/app/video-converter.worker.ts`：浏览器端媒体解析、解码、缩放和像素打包。
- `ui/src/app/mp4-decode-scheduler.ts`：MP4 sample 顺序、解码队列背压和单次终态 `flush()`。
- `ui/src/app/aily-video-format.ts`：AILY 文件头、帧大小、像素打包和预览反解。
- `ui/src/app/app.ts`：宿主通信、界面状态、预览与浏览器导出。
- `i18n/`：`en`、`zh_cn`、`zh_hk` 三套 `VIDEO_CONVERTER` 语言资源。
- `test/fixtures/`：长 GOP MP4 回归样本。
