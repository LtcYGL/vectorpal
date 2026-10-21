# 第三方组件与归属

本仓库自己的代码是 MIT，但下面这些是别人的东西，各自的许可与版权归原作者。

## 协议实现参考

- **wire-pod** — https://github.com/kercre123/wire-pod （MIT）
  `src/pod/` 里的 jdocs / token / chipper / mDNS / 配对流程，是在读它的实现之后写的，
  协议字段、证书用途、机器人侧安装脚本的步骤都来自它。
- `certs/ddl-ep.crt`、`certs/ddl-ep.key` — Digital Dream Labs 的 app-proto 服务端证书，
  由 wire-pod 随包分发。机器人的 :8084 会校验证书，所以这份必须跟着走；
  它属于 DDL，不属于本项目。

## 随仓库携带的第三方文件

- `proto/google/protobuf/descriptor.proto` — Protocol Buffers 的官方 proto 文件，
  版权所有 Google LLC，BSD-3-Clause。`proto/vector/extensions.proto` 要 import 它，
  带上这份就不用依赖 78MB 的 `google-proto-files` 包。
- `public/vendor/blockly/` — Blockly 的浏览器构建产物（Apache-2.0），前端离线加载用。

## 运行时依赖

- **@grpc/grpc-js**、**@grpc/proto-loader**（Apache-2.0）— 和机器人通信
- **google-proto-files**（Apache-2.0）— proto 的公共导入
- **multicast-dns**（MIT）— 自己发 mDNS 应答，不再用会乱广播的 bonjour
- **sherpa-onnx-node**（Apache-2.0）— 本地语音识别
- **opusscript**（MIT）— 解机器人送上来的 Opus
- **blockly**（Apache-2.0）— 图形积木

## 模型

- `models/` 里的中文流式模型：**sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23**
  （csukuangfj，Apache-2.0），由 `npm run model` 下载，不进仓库。

## 商标

Vector、Anki、Digital Dream Labs 及相关标识归各自所有者。本项目不分发机器人固件，
也不修改机器人系统；它只是在本机扮演「机器人以为存在的那朵云」。