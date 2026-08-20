# dsh-notify

DeepSeek Harness 桌面提醒插件:AI 回合结束、需要你回答/批准时,右下角弹出系统通知。你切到别的页面、甚至切到**别的会话**工作时,都不会错过。

> DeepSeek Harness desktop notifications: a system notification when the AI finishes a turn or waits for your input (questions / approvals) — so switching to another page or another session never costs you a missed turn.

## 触发场景(仅三类,每轮至多一条)

| 事件(经 Harness 官方事件流) | 通知 |
|---|---|
| `approval/requested`(等待你的批准,如权限请求) | 需要你的批准(立即) |
| `question/requested`(AI 向你提问,如确认框) | AI 在等你回答(立即) |
| 会话 `running → idle`(整个回合结束) | AI 已回复,**正文带最终回复前两行预览**;纯工具回合/空回复回退为通用提示(宽限期后仅一条) |

回合中段的逐条消息**不会**触发通知;提问/批准使回合暂停时,也不会再补一条"已回复"。

- **切走页面 / 失焦 / 正在看别的会话**:弹系统通知(Windows 右下角),提示音使用系统通知自带的声音;
- **正在看该会话的页面**:不重复打扰(对话框/回复就在眼前);
- 页面内右下角 toast 默认**关闭**,可在设置卡片开启;
- 切走期间错过提示:最新 3 条会被暂存,回到页面 60 秒内自动补弹右下角 toast(仅当 toast 开启;同时覆盖系统"专注助手/勿扰"在全屏时吞掉系统弹窗的情况)。

## 特性

- **零依赖**:纯 JavaScript,无运行时依赖、无构建依赖(打包脚本只用 Node 内置模块);
- **零成本**:无服务器、无遥测,配置存 `localStorage`,对话内容不离开浏览器;
- **事件驱动**:复用 Harness 自带的 `/api/events.mux` 与 `/api/events.host` 帧流(observation tap),**不开新连接、不轮询 DOM**;
- **会话感知**:通过 `session.prompt` / `session.history` 请求追踪你正在工作的会话——**其他会话**的审批/提问/完成都会提醒,只有眼前这一个是"安静"的;
- **失败隔离**:订阅器抛错不影响连接层;权限失败全部静默降级。

## 安装

### 方式 A:一键安装(克隆本仓库的用户,推荐)

```sh
git clone https://github.com/lovesiss/dsh-notify.git
cd dsh-notify
npm run install:global   # lib/ 已随仓库提交,无需构建
```

卸载:

```sh
npm run uninstall:global
```

### 方式 B:全局安装(手动,本机所有 profile 生效)

```sh
# 1. 把包链接进共享后备目录(Windows 用 junction;macOS/Linux 用 ln -s)
New-Item -ItemType Directory -Force `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@shermanono" | Out-Null
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@shermanono\dsh-notify" `
  -Target "D:\path\to\dsh-notify"

# 2. 编辑 $DSH_HOME/cordis.patch.yml(Windows: %USERPROFILE%\.dsh\cordis.patch.yml)
```

```yaml
- insert:
    - id: notify
      name: '@shermanono/dsh-notify'
```

### 方式 C:单 profile 安装(只影响一个 profile)

```sh
#  npm
dsh plugin --profile web add @shermanono/dsh-notify

#  GitHub 仓库
dsh plugin --profile web add "github:lovesiss/dsh-notify"
```

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: notify
      name: '@shermanono/dsh-notify'
```

> 配置分层顺序:内置 bundle → 各 profile 的 `cordis.patch.yml` → **机器级 `$DSH_HOME/cordis.patch.yml`(应用到所有 profile)** → `--patch` 覆盖。不要编辑同目录的 `cordis.yml`。

### 重启并授权

```sh
dsh web
```

打开页面后**点击页面任意位置一次**——浏览器要求用户手势才能请求系统通知权限,插件会在首次点击时自动请求。权限弹窗选择允许即可。

### 验证

在浏览器控制台执行:

```js
__dshNotify.test()   // 立即弹一条测试通知
```

## 配置

**方式一(推荐):设置页开关卡片** —— 打开 DSH 设置 → 插件 → **通知 (dsh-notify)** 标签页:总开关 / 系统通知 / 页面内 Toast(默认关),三个即时生效的开关 + 测试按钮。注册在官方 `settings.plugins.tab` 插槽上,不需要任何主机改动。

**方式二:控制台**

```js
__dshNotify.setConfig({ toast: true, toastMs: 8000 })
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `os` | `true` | 系统通知(切走/失焦/看别的会话时弹) |
| `toast` | `false` | 页面内右下角 toast(默认关) |
| `cooldownMs` | `1500` | 同会话同类通知的冷却(帧风暴只弹一条) |
| `toastMs` | `5000` | toast 停留时长 |

配置即写即生效,持久化在 `localStorage`。

## 卸载

```sh
npm run uninstall:global                 # 一键:移除补丁行 + 移除模块链接
# 或手动:
# 1. 删除 cordis.patch.yml 中的 notify 行;
# 2. dsh plugin --profile web remove @shermanono/dsh-notify;
# 3. 重启 dsh web。
```

## 隐私

本插件不发起任何网络请求、不收集任何数据;它只读取 Harness 已下发给当前页面的会话帧,并在本地弹出通知。

## License

[MIT](LICENSE)
