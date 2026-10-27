# koishi-plugin-local-package-upload

## 项目介绍

这是一个为 Koishi 机器人框架开发的**本地插件上传服务**，自带控制台页面。

它负责四件事：分片接收归档、安全校验归档内容、按内容哈希落盘、调用包管理器完成安装。

用户只需在控制台拖入一个 `npm pack` 生成的 `.tgz`，即可安装到当前应用。

## 项目仓库

- GitHub：https://github.com/Minecraft-1314/koishi-plugin-local-package-upload
- Issues：https://github.com/Minecraft-1314/koishi-plugin-local-package-upload/issues

## 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 是否启用本地上传 |
| `chunkSize` | number | `8192` | 上传分片大小，从下列档位中选择 |
| `maxSize` | number | `67108864` | 单个归档大小上限（字节），即 64 MiB |
| `ttl` | number | `900000` | 未完成上传的保留时间（毫秒），即 15 分钟 |
| `directory` | string | `.yarn/local` | 归档落盘目录，相对应用根目录 |
| `prefix` | string | `package` | 归档内清单所在目录，npm pack 生成的是 `package` |
| `maxSessions` | number | `8` | 同时存在的上传会话上限 |
| `maxConcurrentChunks` | number | `4` | 单个会话并发处理的分片上限 |
| `scanBudget` | number | `30000` | 单个归档安全扫描的时间上限（毫秒） |

### chunkSize 可选档位

| 档位 | 单条消息大小 | 建议 |
|------|------|------|
| **`8 KiB`（默认）** | 约 11 KB | 兼容性最好，适用于任意受限链路 |
| `16 KiB` | 约 22 KB | 链路较宽松，分片数更少 |
| `32 KiB` | 约 44 KB | 仅链路确认可传 44 KB 以上时使用 |
| `64 KiB` | 约 87 KB | 仅链路确认可传 87 KB 以上时使用 |
| `128 KiB` | 约 175 KB | 仅链路确认无帧大小限制时使用 |
| `256 KiB` | 约 350 KB | 仅链路确认无帧大小限制时使用 |
| `512 KiB` | 约 683 KB | 兼容性最差，仅用于对照测试 |

分片越小兼容性越好，代价是分片数量增加。151 KB 归档在 8 KiB 分片下为 19 片，2 MiB 约 256 片。


## 控制台界面

启用插件后，控制台底部导航新增「本地上传」页面（路径 `/local-upload`，权限等级 4）。

页面自上而下分为五块：

| 区块 | 内容 |
|------|------|
| 标题区 | 页面标题、说明文字，以及「刷新」「选择文件」两个按钮 |
| 状态卡片 | 归档大小、分片大小、上传进度三项实时状态 |
| 拖拽区 | 拖入或点击选择 `.tgz`，上传中显示进度条与已传字节数 |
| 校验结果 | 包名、版本、大小、哈希、描述，以及生命周期脚本警告 |
| 操作说明 | 四步使用指引 |

校验完成后点击「安装」，会弹出全局安装进度窗口，逐条输出归档校验、落盘、生命周期脚本提示、包管理器执行等日志，完成后显示安装结果。安装进行中窗口不可关闭，避免误操作中断。

若归档包含 `preinstall`、`install`、`postinstall`、`prepare` 脚本，页面会显示黄色提示，说明安装时不会自动执行。

## 控制台接口

本插件**不向外暴露任何服务**，上传能力仅供自身界面使用。插件会在 Console 上注册以下接口，权限等级 4。

| 接口 | 参数 | 返回 |
|------|------|------|
| `local-package-upload/start` | `{ filename, size }` | `{ uploadId, chunkSize, maxSize }` |
| `local-package-upload/chunk` | `{ uploadId, index, data }` | `{ received, size }` |
| `local-package-upload/finish` | `{ uploadId }` | 校验结果，含包名、版本、哈希、生命周期脚本 |
| `local-package-upload/commit` | `uploadId` | `{ name, version, filename, request, size, hash }` |
| `local-package-upload/cancel` | `uploadId` | `boolean` |
| `local-package-upload/install` | `uploadId` | `{ name, version, request }`，需要 `installer` 服务 |

客户端必须按 `start` 返回的 `chunkSize` 切片，分片 `index` 从 0 递增且不可跳号。

## 安全校验

上传的归档在落盘前会经过完整扫描。任一项不通过即拒绝，不写入任何文件。

### 文件名

| 检查项 | 说明 |
|------|------|
| 扩展名 | 必须是 `.tgz` |
| 路径 | `basename` 必须等于自身，拒绝任何路径分隔符 |
| 长度 | 不超过 214 字符 |
| 保留名 | 拒绝 `con`、`prn`、`aux`、`nul`、`com1-9`、`lpt1-9` |
| 控制字符 | 拒绝 `\x00-\x1f`、`\x7f` |
| 路径穿越 | 拒绝包含 `..` |

### 归档结构

| 检查项 | 上限 |
|------|------|
| 条目类型 | 仅允许文件、目录与 POSIX 元数据；拒绝符号链接、硬链接、设备文件、FIFO |
| 条目数量 | 8192 |
| 解压总大小 | 256 MiB |
| 单文件大小 | 64 MiB |
| 压缩比 | 1000 |
| 路径长度 | 512 字符 |
| 路径片段长度 | 128 字符 |
| 路径层级 | 32 层 |
| 绝对路径 | 拒绝 `/` 开头与盘符开头 |
| 路径穿越 | 拒绝 `.`、`..` 片段 |
| 清单唯一性 | `package/package.json` 有且仅有一个 |
| 清单大小 | 1 MiB |
| 扫描时长 | `scanBudget` 毫秒，超时中止 |

### package.json

| 检查项 | 说明 |
|------|------|
| 结构 | 必须是对象，嵌套深度不超过 16 |
| 循环引用 | 直接拒绝 |
| 字段总数 | 单层不超过 512 |
| 字段名 | 长度与控制字符校验 |
| `name` | 必须是 Koishi 插件命名，支持 `@scope/` |
| `version` | 必须是合法 SemVer |
| `bin` | 拒绝路径穿越与绝对路径，条目不超过 64 |
| `scripts` | 键名合法、内容为字符串、不超过 128 项 |
| 依赖字段 | `dependencies` 等四项的值必须是字符串 |
| `description` / `license` / `author` / `homepage` / `main` / `module` | 长度与控制字符校验 |
| `engines` | 必须是对象，值为字符串 |

### 生命周期脚本

识别 `preinstall`、`install`、`postinstall`、`prepare`、`prepublish`、`prepack` 并在界面标注，**不会自动执行**。

### 会话防护

| 检查项 | 默认 |
|------|------|
| 会话数量上限 | 8，超出时回收最旧会话 |
| 单会话并发上限 | 4，超出直接拒绝 |
| 分片顺序 | 必须从 0 连续递增，不可跳号 |
| 分片大小 | 不得超过 `chunkSize` 与剩余字节数的较小值 |
| base64 | 长度合法、字符集合法、回编码一致 |
| 会话 ID | 必须匹配 UUID 格式 |
| 落盘路径 | 必须位于落盘目录的直接子级 |
| 内容冲突 | 同名文件哈希不一致时拒绝覆盖 |
| 过期清理 | 每 5 分钟清理超时会话与孤立临时文件 |


## 故障排查

**上传卡在 0 B 后超时**

链路限制了单帧大小。把 `chunkSize` 调到更小的档位（例如 `4096` 需自行在配置中指定）后重启。

**提示「本地插件上传分块编码无效」**

客户端发送的分片超过了服务端配置的 `chunkSize`。确认客户端读取的是 `start` 返回的分片大小，而不是自己写死的值。

**提示「本地插件归档中缺少 package/package.json」**

归档不是 `npm pack` 生成的，或者顶层目录不是 `package`。用 `npm pack` 重新生成即可。


## 项目贡献者

| 贡献者 | 贡献内容 |
|------|------|
| Minecraft-1314 | 插件完整开发 |

> 欢迎通过 Issues 或 PR 加入贡献者列表。

## 许可协议

本项目采用 MIT 许可证，详情参见 [LICENSE](LICENSE) 文件。

## 支持我们

如果这个项目对您有帮助，欢迎点亮右上角的 Star 支持我们！