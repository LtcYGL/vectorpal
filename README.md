# VectorPal

把一台 Anki Vector 2.0 整个接管过来：本机跑一个自部署的 pod（机器人以为自己在连云端），
再配一个中文控制台 —— 实时状态、说话、动作库、眼睛、看世界、语音唤醒、积木编程、互动记录，全在一个网页里。

> Digital Dream Labs 已经不在了，Vector 的官方云也关停多年。没有 pod，它连不上网、只会自己发呆；
> 有了 VectorPal，这台小机器人重新能听、能干、能编程。

---

## 它能做什么

| | |
|---|---|
| 状态 | 姿态、头部、升降、电量、触摸、加速度、陀螺仪、状态位，约 14Hz 实时推 |
| 动作 | 固件自带的 **1208 个动画** + **479 个触发器**，搜名字点一下就播 |
| 运动 | 前进/后退/转向（陀螺仪闭环，90° 误差约 ±0.8%）、抬头、升降 |
| 眼睛 | 色相/饱和度/亮度任意调 |
| 看世界 | 拍照、相册、按秒看的实时画面 |
| 说话 | 本机 SAPI 合成中文语音，推到机器人喇叭（固件自己的 TTS 在 3.x 上已废） |
| 语音唤醒 | 「Hey Vector」或按头顶按钮 → 本地 STT 听中文 → 按你说的做 |
| 编程 | 点按积木 / Blockly 图形积木 / 直接写 JSON，能拍照、能循环、能被摸头触发 |
| 自动反应 | 被摸、被抱起、放上充电台、看到桌边 → 触发一段编排 |
| 记录 | 每天跟它做过什么，给家长看 |
| 手册 | 站内 wiki：能力边界、动作库、函数库（每行带「试」按钮）、报错对照 |

---

## 跑起来需要什么

1. **Windows 10/11**（语音合成走系统 SAPI，配对走系统 OpenSSH；其它系统还没适配）
2. **Node.js ≥ 22.18**（[下载](https://nodejs.org/)）——直接跑 `.ts`，不用编译
3. **一台解锁过的 Vector**：刷了 WireOS / OSKR 的固件，SSH 能登（`root@<机器人IP>`），
   手上要有它的 SSH 私钥。原厂固件得先刷系统。
4. 电脑和机器人**在同一个局域网**（机器人连的是家里 Wi-Fi，电脑最好走网线，mDNS 更稳）

---

## 两种拿法

**A. 便携包（推荐给不想碰命令行的人）**

去 [Releases](../../releases) 下 `vectorpal-<版本>-win-x64.zip`（约 63MB），解压后双击 `start.bat`：
后台起 pod，8 秒后自动打开控制台。包里自带 node 运行时、依赖、中文语音模型，不用装任何东西。

**B. 从源码跑**

```bash
git clone https://github.com/LtcYGL/vectorpal.git
cd vectorpal
npm ci               # 只装运行时依赖，约 36MB
npm run model        # 下载中文语音模型（约 25MB，跳过也能用，只是听不懂话）
npm start
```

启动后：

1. 浏览器打开 **http://本机IP:8090**（本机访问；局域网访问要输 PIN，PIN 在启动日志或 `data/api-pin.txt`）
2. 进「设置」→「接入机器人（配对）」：填机器人 IP + SSH 私钥 → 点开始
   → 它会自己写配置、装证书、重启，两三分钟后回来
3. 机器人连上后，页头两个绿点亮起来，就能玩了

> 第一次配对之后，`data/` 里会有这台机器人的信息，`certs/` 里会有它的证书，都是本机生成的，不要提交到仓库。

### 后台常驻

```bash
npm run keepalive        # 守护进程：pod 挂了 10 秒内拉起来
```

Windows 上想开机自启、不弹黑框：双击 `start-hidden.vbs`（它用当前目录的 `node` 起守护进程）。

### 自己打便携包

```bash
npm ci --omit=dev
npm run model
node scripts/build-portable.mjs
```

产出 `dist/vectorpal-<版本>-win-x64/` 和同名 `.zip`，内容就是 Release 上那个包。

### 发版流程

GitHub **不会**替你编译出各系统的可运行包，它只自动附上 `Source code (zip/tar.gz)`。
可运行的二进制要靠 CI 构建 —— 本仓库带了 `.github/workflows/release.yml`：推一个 tag 就自动在
`windows-latest` 上装依赖、下模型、打包，并把 zip 挂到 Release 上。

```bash
git tag v1.0.0
git push origin v1.0.0        # 触发 Release 工作流
```

工作流也可以在 Actions 页面手动 `Run workflow`，那样只出一个可下载的构建产物，不发 Release。

**为什么只有 Windows 包**：这个项目跑在 Windows 上（语音合成走系统 SAPI、配对走系统 OpenSSH、
自启脚本是 VBS）。Linux/macOS 上克隆源码能读能跑一部分，但说话和配对都不可用，
所以不给它们出「可运行包」——出了也用不了，不如老实说。

---

## 端口

| 端口 | 干什么 | 谁能访问 |
|---|---|---|
| 80 | 机器人的 connCheck（问「我的云端在不在」） | 局域网 |
| 443 | jdocs / token / chipper（机器人主通道，自签证书） | 局域网 |
| 8084 | app-proto（机器人另一个云端通道，用 DDL 的证书） | 局域网 |
| 5353 | mDNS 广播 `escapepod.local` | 局域网 |
| 8090 | 控制台网页 + API | 可设本机或局域网 |

80/443 被占（IIS、其它 pod）会起不来，先关掉占用的程序。第一次运行 Windows 会弹防火墙授权，要允许。

---

## 目录

```
src/pod/        pod 本体：jdocs / token / chipper / mDNS / :80 / 配对 / 证书
src/bridge/     跟机器人的 gRPC 通道（连接、事件流、动作闭环、互斥）
src/api/        控制台 HTTP API（8090）
src/audio/      TTS(SAPI) / STT(sherpa-onnx) / Opus / WAV
src/program/    积木执行引擎 + 自动反应规则
src/voice/      唤醒 → 识别 → 匹配 → 执行
public/         前端（单文件，无构建）：index.html / blocks.js / wiki.html / vendor
proto/          jdocs / token / chipper 的 proto，和机器人 SDK 的 proto
certs/          DDL 的 8084 证书；自签证书与机器人证书运行时生成
data/           运行时数据（不进仓库）
assets/         机器人侧安装脚本
```

---

## 常见问题

**启动就报端口被占用（443 / 80）**
其它 pod、IIS、Skype 都可能占着。Windows 上 `netstat -ano | findstr :443` 找到 PID 再关掉。

**页头「机器人在线」一直是灰的**
先看 `logs/pod.log`。常见原因：机器人没连上 Wi-Fi、配对时 IP 填错、机器人的 `server_config.json` 还指着旧地址（重新配对一次）。

**动作点了没反应**
它站在充电仓上时固件会忽略一切外部马达指令，先抱下来；动画名不在固件清单里也不会动（引擎日志会写 `AnimNotFound`）。

**语音听不懂**
`npm run model` 没跑、或者模型目录不全。识别窗口只有 6 秒，靠它近一点、说慢一点。

**能和 wire-pod 一起跑吗**
不要。两边都想占 :443 和 :8084，同一台机器只能有一个 pod。

---

## 许可与致谢

- 本项目 **MIT**，见 [LICENSE](LICENSE)。
- pod 协议、jdocs/token/chipper 的实现参考了 [wire-pod](https://github.com/kercre123/wire-pod)（MIT），
  8084 用的 `certs/ddl-ep.*` 就是它随包携带的那份 DDL 证书；没有它机器人不接受这条通道。
- 语音识别用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，模型是 csukuangfj 的中文流式 zipformer。
- 图形积木用 [Blockly](https://github.com/google/blockly)。
- Vector / Anki / Digital Dream Labs 的商标与固件版权归各自所有者；本项目不分发固件，也不修改机器人系统。