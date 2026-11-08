# Linux ByteVC2 播放、下载与转码 · 实施与验收记录

实施日期：2026-11-08。基线 `237d653`（Linux `1.74.13`），对应设计
[linux-bytevc2-playback-design.md](linux-bytevc2-playback-design.md)。本文记录代码改动、
离线回归、实网验证、成品验证与未覆盖项。正式发行（版本号、发行说明、产物上传）单独安排。

## 结论总览

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| A · CPU 兼容 | **已通过** | 第 17–20 集实网取源后可播、可下载；干净包校验与更新流程通过 |
| B · 核显编码 | **机制已通过，默认关闭** | 真实 Iris Xe 上 VAAPI 输出逐字节复现基准；尺寸门槛未达标，默认仍为 CPU（按设计保持开发验证项） |
| C · 连播验收 | **已通过（脚本化实网）** | 下一集预取、前台接管不重启转换、取消清理、重启缓存复用、冷/热切集计时 |

## 代码改动

**新增**

- `src/native/bytevc2.js` — 共享转换模块：单任务队列（当前播放 > 下一可播集 > 下载 > 远集预取，
  同级 FIFO，运行中任务只提升优先级不重启）、AbortSignal/CancelToken 双取消、
  `-protocol_whitelist file,pipe`、CENC 密钥同进程解密解码、x264 `veryfast/CRF 23`、
  解码/编码各 2 线程 + 滤镜/lookahead 各 1 线程、进度按输出媒体时长、排队/转码阶段回调、
  磁盘写满（ENOSPC）直接结束、可选 VAAPI 尝试 + 同输入一次 CPU 回退。不写密钥与原生诊断。
- `scripts/build-librempeg-source.sh` — 固定源码构建：Librempeg `cb1f8f3…`、x264 `b35605a…`
  （SHA256 校验）。`linux-x64` 产出静态 x264、仅依赖 glibc 的 `librempeg`；
  `linux-x64-vaapi` 产出动态链接 libva/libdrm、含 `h264_vaapi` 与 lavfi 试编组件的
  `librempeg-vaapi`。两者都生成对应源码归档并复制许可正文。
- `build/ffmpeg/LIBREMPEG-NOTICE.txt` 与四份许可正文 — 来源、构建方式与分发义务说明。
- `scripts/check-bytevc2-playback.cjs`、`src/native/bytevc2.test.cjs` — 离线回归（见下）。

**修改**

- `src/native/app-source.js` — ByteVC2 进入候选：仅当模型自带 `video_id`、正的完整时长与实际
  宽高时可用；`auto` 与固定画质均先选 H.264/HEVC，兼容原片不满足固定画质时才按同一尺寸规则选
  ByteVC2；ByteVC2 变体携带 `codec/width/height/duration`；低于画质返回 `QUALITY_UNAVAILABLE`
  （含实测尺寸），不可确认返回明确原因的 `UNSUPPORTED_CODEC`。
- `main.js` — 三个入口接入共享转换：磁盘准备（`prepareDiskEpisode`，下载→转换→FFprobe 校验→
  发布 `video.mp4`，记录 `originalCodec/conversion`）；非磁盘在线播放（ByteVC2 先生成受管 H.264
  文件再经流协议分段读取）；手动下载（`executeHongguoDownload` 直接用密钥转换，下载进度带
  `stage=queued/transcoding` + `stagePercent`）。队列优先级随前台接管动态提升；VAAPI 默认关闭
  （`HONGGUO_BYTEVC2_VAAPI=1` 开启，设备探测对象为加速组件本身）。输出校验：H.264 轨、原尺寸、
  画质下限、完整时长（1 秒容差）、AAC 音轨（音轨无法保留时转换前明确失败）。
- `src/native/playback-cache.js` — 清单可选字段 `originalCodec`、`conversion`；旧缓存按原规则读取。
- `src/native/linux-update.js` — 新增 `FULL_COMPONENTS`（含 `librempeg`）：新包与更新包必须带齐，
  旧安装（无辅助程序）仍可正常升级。
- `src/native/hongguo.js` — 错误文案反映实际支持能力。
- `src/components/episodeStatus.mjs`、`Player.jsx`、`DownloadManager.jsx` —
  新增「等待转码/正在转码」阶段与百分比、下载页转换阶段标签。
- `scripts/setup-ffmpeg-linux.js` — 打包前校验辅助程序：ELF x86-64、系统库依赖、CPU 版无
  libva/libdrm、`bvc2` 解码与（存在时）`h264_vaapi` 编码能力；缺失即失败（`HONGGUO_SKIP_LIBREMPEG=1`
  仅供本地调试）。
- `package.json` / `.gitignore` / `.github/workflows/linux.yml` — 随包 `resources/bin` 携带两个
  辅助程序与许可；CI 从固定源码构建（nasm、libva-dev、libdrm-dev），对应源码归档随发行产物上传。
- `scripts/check-app-source.cjs`（+6 用例）、`check-linux-package.cjs`、`check-linux-update.cjs`、
  `check-linux-update-bundle.cjs`、`check-live-app-playback.cjs`、`check-playback-suite.cjs`（登记新检查）。

## 离线回归（2026-11-08，Node 22.22.3）

- `npm run test:playback`：**60/60 通过**（2 项按设计跳过：需要实网夹具的 hls-media）。
- `src/native/bytevc2.test.cjs`：20/20 — 队列串行与优先级提升不重启、排队阶段与取消（信号/令牌）、
  失败释放队列、EEXIST、`-fs` 上限、时长不完整拒绝、诊断信息不泄露、VAAPI 参数与 CPU 回退、ENOSPC 不重试。
- `scripts/check-app-source.cjs`：20/20 — H.264/HEVC 优先、ByteVC2 独占同档候选与密钥/时长、
  明文候选、固定画质回退规则、低于画质错误、身份不可确认与未知编码错误。
- `scripts/check-bytevc2-playback.cjs`：9/9 — 三个入口、缓存身份字段与复用、阶段事件、
  预取优先级与前台接管、最后消费者取消清理、缺组件明确报错、兼容模式直接复用已转换 H.264、
  下载发布与失败保留重试状态。
- `npm run build:react`：通过。

## 实网验证（2026-11-08，对照剧 `7703760419889876030`）

机器：Ubuntu 26.04.1、i5-1135G7 / Iris Xe。全部使用隔离临时用户数据与下载目录。

`scripts/check-live-app-playback.cjs`（CPU 默认路径）：

| 分集 | 取源编码 | 发布形态 | 结果 |
| --- | --- | --- | --- |
| 17 | hevc 1920×1080 | 原片直放 4,502,663 B | Range 206、3 秒解码、下载发布通过 |
| 18 | bytevc2 1920×1080 | H.264 10,928,285 B（`libx264-v1`） | 同上，与基准 CPU 输出逐字节一致 |
| 19 | bytevc2 1920×1080 | H.264 16,116,884 B（`libx264-v1`） | 同上，与基准 CPU 输出逐字节一致 |
| 20 | hevc 1920×1080 | 原片直放 5,809,726 B | 通过 |

`HONGGUO_BYTEVC2_VAAPI=1`（阶段 B，真机）：

- 第 18 集：`h264_vaapi-v1`，19,260,178 B — 与基准「核显编码」输出逐字节一致（SSIM 0.99259）。
- 第 19 集：`h264_vaapi-v1`，30,057,386 B — 同上（SSIM 0.99201）。
- 将加速组件替换为必定失败的桩后，同一任务自动回退 CPU 并发布与 CPU 基准逐字节一致的输出。
- 探测命令在 `librempeg-vaapi` 上试编一帧通过（lavfi 输入设备随加速构建提供）。

连播验收 `work/bytevc2-acceptance.cjs`（真实取源 + 真实辅助程序）：

- 第 17 集前台 0.8–1.3 秒就绪（HEVC 直放）。
- 第 18 集以 `next` 角色预取，前台立即接管同一任务：仅一次转换，总耗时 20.3–29.0 秒
  （含取源与完整下载）。
- 第 19 集冷启动 24.6–25.6 秒；第 20 集自然连播 0.9–1.3 秒（HEVC）。
- 转换中取消第 18 集：任务终止、该集不留完整缓存（缓存清单仅 17/19/20）。
- 「重启」（同一 userData 重新加载主进程）后第 19 集缓存命中：25 毫秒，无重新下载或转换。

**核显默认启用门槛（设计第 4 节）**：现有两段样本中 VAAPI 输出为 CPU 版的 1.76×/1.87×，
超过「不超过 1.25 倍」的要求；且设计要求至少三段样本。因此 **VAAPI 保持默认关闭**（CPU 路径
始终可用），加速以 `HONGGUO_BYTEVC2_VAAPI=1` 作为开发验证开关。基准数据见
`work/bytevc2-gpu-test/benchmark.log`。

## 成品验证

- `npm run package:linux` 通过：`dist/hongguo-drama-1.74.13-linux-x64.tar.gz`（256.7 MB）。
  `app/resources/bin` 含 `ffmpeg`、`ffprobe`、`librempeg`（9.4 MB，ldd 仅 libc/libm）、
  `librempeg-vaapi`（9.6 MB，动态链接 libva/libdrm）与全部 LIBREMPEG 许可文件。
- `node scripts/check-linux-update-bundle.cjs` 通过：真实 Electron Node 运行时、完整发行包
  原位更新、旧版（无辅助程序）升级、缺 `librempeg` 的新包被拒绝、降级保护、历史与启动器保留、
  更新后提供可执行辅助程序。
- 本机构建产物（未入库，随 CI 从固定源码重建）：
  `librempeg` SHA256 `f5e3d89c8f61f21e18276f81a072f580aa20ce47993df2354741669945582a9b`；
  `librempeg-vaapi` SHA256 `dc8aaae02a3155feaeb174848824c3b203fbdf80ec09de0e116e927459e0730f`。
  对应源码归档：`work/librempeg-cpu-build/artifacts/`、`work/librempeg-vaapi-build/artifacts/`。

## 未覆盖项

- 非 Intel 核显（AMD/NVIDIA VAAPI）与多显卡设备上的加速路径仅静态校验，未实测。
- 无 DRM 节点 / 权限不足主机上的 VAAPI 探测仅由单元与桩测试覆盖（CPU 回退路径已实测）。
- 图形界面内的真实窗口连播（暂停后拖动、全屏抽屉状态）未人工操作；已用同一主进程 IPC 的
  脚本化实网流程覆盖切集、预取、接管、取消与重启。
- 其他发行版 / 更早 glibc / ARM 的干净环境运行；CI（ubuntu-24.04）按固定源码构建并复检。
- 未安装 libva 的主机上整包运行（设计要求 CPU 组件完整可用）：CPU 辅助程序无 libva 依赖已由
  ldd 与打包校验保证，整机无图形栈环境未实测。

## 交付物索引

- 代码与测试：见「代码改动」；全套离线回归入口 `npm run test:playback`。
- 实网脚本：`scripts/check-live-app-playback.cjs`（支持 `HONGGUO_LIVE_CASES` 指定分集）、
  `work/bytevc2-acceptance.cjs`（连播验收，临时）。
- 基准与构建日志：`work/bytevc2-gpu-test/benchmark.log`、`work/librempeg-cpu-build/`、
  `work/librempeg-vaapi-build/`（含对应源码归档）。
- 成品：`dist/hongguo-drama-1.74.13-linux-x64.tar.gz`（临时构建，正式发布另行安排）。
