# dsh-vault

中文 | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）
插件，把**所有对话和日志保存在工作区文件夹内部**，让工作区文件夹成为自包含、
可移植的存档。

安装 `dsh-vault` 后，每个工作区文件夹里会出现一个 `dsh-session-vault/` 目录：

```
my-project/
  dsh-session-vault/
    workspace.json          # 工作区名称（标题）+ 保险库标记
    sessions/
      <session-id>.jsonl    # 每个会话一个追加式对话日志
```

- 每个 `cwd` 指向该工作区的会话都会在发生时被实时镜像到
  `dsh-session-vault/sessions/`。
- 工作区标题被缓存在 `dsh-session-vault/workspace.json` 里。

## 为什么这样就能在新电脑上恢复

1. 把工作区文件夹（整个目录，包括 `dsh-session-vault/`）复制到新电脑。
2. 在新电脑上安装 DSH 和本插件。
3. 把复制的文件夹作为工作区打开。

打开时，`dsh-vault` 会把保险库里的每个会话导入回 DSH 持久化（并把每个会话的
`cwd` 重新绑定到文件夹当前所在位置），同时从 `workspace.json` 恢复工作区名称。
所有对话——包括工作区名称——都会回来。

## 安装

### DeepSeek Harness 桌面版

在桌面版的**插件管理**里添加插件时，填 GitHub 规格（注意不是包名）：

```
github:XiaoWind/dsh-vault#<40 位 commit sha>
```

**请钉住完整 40 位 commit。** DSH 插件管理器只对来源固定到完整 commit 的 git
插件报告 `update: 'git'`，并允许它热更新；这也是本插件运行时自动更新的前提
（见下文「自动更新」）。不带 `#<sha>` 也能安装，但自动更新会保持关闭。

桌面版会在 profile 目录里执行 `pnpm add`，并用本包 `engines.dsh`
（`>=0.2.2-rc.5 <0.3.0`）校验当前 DSH 版本；不兼容时拒绝安装并回滚
`package.json`、`pnpm-lock.yaml` 和 `node_modules`。校验通过后把本包加入
`dsh.profile.bundles`。**安装后按提示重启桌面应用**才会生效。

> **必须使用 `github:owner/repo` 这种规格。** 本插件没有发布到 npm registry，
> 只写 `dsh-vault` 会去 npm 上查找，安装会失败。

### CLI / Web 版

```sh
# 从 GitHub 安装，并钉住完整 commit（自动更新的前提）
dsh plugin --profile web add "github:XiaoWind/dsh-vault#<40 位 commit sha>"

# 也可以只用默认分支安装（自动更新保持关闭）
dsh plugin --profile web add github:XiaoWind/dsh-vault
```

`dsh plugin` 会把参数转发给 `web` profile 目录内的 `pnpm`，随后自动把该包加入
`dsh.profile.bundles` 层级列表（因为本包声明了 `dsh.bundle.patch`）。安装后请
重启 Web 应用。

> 本插件注入 `sessionPersistence`、`workspaceRegistry` 和 `commands` 服务，因此
> 只在包含这些 host 服务的 profile 中生效——官方自带的 `web` profile 就包含它们。

## 自动更新

插件自带运行时自动更新，不需要外部脚本：

1. 启动约 90 秒后检查一次 GitHub 上 `XiaoWind/dsh-vault` 的最新 commit，之后每
   6 小时检查一次；
2. 读取该 commit 的 `package.json`，仅当 `version` 比运行中的版本新时才更新；
3. 通过 DSH 插件管理器把安装整体热更新到该 commit（固定到 40 位 sha 的 git
   规格）。桌面版 profile 启用 HMR，插件会被移除并以新版本重新加载，无需重启；
4. 成功或失败都会以会话通知的形式报告；失败不会改变正在运行的版本，下一轮检查
   会重试。

**前提**：本插件必须以固定 40 位 commit 的规格安装（见「安装」）。未固定的安装
不会自动更新；`/vault update` 会提示重新安装的方式。

自动更新只替换插件代码，**不会改动任何保险库文件**；更新前后 `dsh-session-vault/`
里的记录保持原样。

可在 profile 的 `cordis.patch.yml` 中调整：

```yaml
- id: vault
  config:
    autoUpdate: true                 # false 关闭自动检查
    updateCheckIntervalMs: 21600000  # 两次检查间隔（默认 6 小时）
    updateInitialDelayMs: 90000      # 启动后首次检查延迟（默认 90 秒）
```

设置环境变量 `DSH_PLUGIN_AUTO_UPDATE=0` 可全局关闭自动更新。检查走
`api.github.com` 与 `raw.githubusercontent.com`；若遇到未认证请求限流，可在环境
中设置 `GITHUB_TOKEN`。手动触发一次检查：`/vault update`。

### 手动更新（不使用自动更新时）

**桌面版**：在插件管理里移除本插件，再按固定 commit 的规格重新添加；更新后重启
桌面应用。

**CLI / Web 版**：

```sh
dsh plugin --profile web update dsh-vault
# 或显式钉到新 commit
dsh plugin --profile web add "github:XiaoWind/dsh-vault#<新 commit sha>"
```

更新后请重启应用——bundle 层在启动时组合，运行中的进程不会热更已安装的插件。

## 用法

保险库全自动运行，无需额外配置。提供了 `/vault` 斜杠命令用于查看和手动控制：

| 命令 | 作用 |
|---|---|
| `/vault status` | 查看已保险的工作区及每个工作区的会话数量。 |
| `/vault restore` | 立即为已知工作区导入保险库中的会话/标题。 |
| `/vault export` | 立即把当前持久化数据（重新）写入保险库文件。 |
| `/vault update` | 立即检查一次插件更新。 |
| `/vault help` | 查看帮助。 |

### 行为说明

- **持续镜像。** 会话每追加事件，就按顺序写入该工作区的
  `dsh-session-vault/sessions/<id>.jsonl`；会话销毁时会把文件重写为一份干净快照。
- **按当前会话格式原样保存头部。** 保险库文件头部的字段集完全跟随宿主会话格式
  （v4 要求 `isSeeded`，并拒绝早已废弃的 `seedLength`），因此插件不会因为宿主
  格式演进丢字段或伪造字段。
- **自动恢复。** 启动时、以及每次打开工作区时，插件都会导入 DSH 持久化中缺失
  的保险库会话，并应用保险库里的标题。在全新电脑上把复制的文件夹作为工作区打开，
  同样会触发恢复。
- **路径可移植。** 导入时会把会话的 `cwd` 重新绑定到工作区当前的绝对路径，因此
  复制到不同位置的文件夹也能干净恢复。
- **幂等。** 已存在于持久化中的会话不会被重复导入；无需变更时，挂载/重命名不会
  产生任何写入。
- **恢复出来的会话不会留在归档里。** 归档是"注册表全局"的：会话会从所有列表里消失，
  但保留工作区里的位置。插件在**导入**会话时会把它从归档集合取出；显式执行
  `/vault restore` 时，也会把该工作区保险库里已存在的会话一并取出——否则"恢复成功"
  和"什么都没发生"在界面上完全一样。启动流程只处理它自己导入的会话，**不会撤销用户
  主动做的归档**。
- **记录会自动补全。** 插件只在自己运行期间镜像事件；如果某个会话在插件未加载时
  （切换运行时、重装插件等）继续追加事件，这一段就不会进入保险库文件。会话再次
  打开时，插件会比对文件与内存中的完整日志并补全文件；会话销毁时也会写入完整
  快照。`/vault export` 则按当前持久化数据强制重写全部保险库文件，可随时彻底修复。
- **记录只会被补全，绝不会被缩小。** 插件只在能读到会话完整日志时才重写记录；读不到
  日志时只补建缺失的头部，绝不拿一份"空日志"覆盖已有记录。任何重写——**包括
  `/vault export`**——都先确认新日志覆盖了记录里**最高**的 `seq`，而不是只看文件最后
  一行：日志末尾可能残留旧世代或同步合并产生的行，只按末行判断会误判记录长短
  （0.1.8 曾因此在 2026-11-19 把一条 1587 条事件的记录覆盖成 52 条）。需要判断"是否会
  缩小"且文件比待写内容更大时，插件会完整扫描求出真实最大 `seq`，超出新日志范围就
  拒绝写入并记警告。确实要用较短的持久化日志覆盖记录时，先手动删除该
  `<id>.jsonl`，再执行 `/vault export` 重建。
- **空壳记录自动修复。** 若保险库记录只剩头部、而 DSH 持久化里该会话仍有内容
  （按存储产物大小判断），启动导出流程会从持久化重新写回整份记录。被误清空的记录
  在重启后会自动恢复，不需要手动操作。
- **不完整的记录按"能还原多少就还原多少"处理。** DSH 的持久化日志必须是 `seq` 从 0
  开始、逐条连续的序列。
  - **缺少开头**（记录从 `seq 6` 开始）：开头的事件已无来源，把后面的事件当成 0 号会
    篡改历史，因此整条记录会被跳过，并在日志里写明原因（`its log starts at seq 6`）。
  - **中间有缺口、开头完整**：插件会导入缺口之前那段连续的**前缀**，让会话结束在缺口
    处——崩溃的会话本来就是这个形态——同时记一条警告说明有多少条后续事件无法到达
    （例如 `restoring session "…" up to seq 1078: 2 later event(s) are unreachable
    because its log has a hole`）。这样丢一条事件不会毁掉整段对话。
  - 想要完整记录，请在源机器上执行 `/vault export`（按持久化重写），或把会话再打开
    一次让插件补全，然后再复制。
- **持久化里"已存在"但更短的会话会被检查。** 恢复只导入"持久化里没有"的会话，但
  *已存在不等于完整*：同一段对话在另一台机器上继续过（工作区文件夹通过 Syncthing /
  OneDrive 等同步，保险库记录被同步过来，而会话存储 `~/.dsh/sessions` 是每台机器各自
  的），或者日志被崩溃截断，都会留下一个很短的会话把保险库内容永久挡住。插件会在
  启动和 `/vault restore` 时比较两者：
  - **存储里的日志是记录的真前缀**：把记录多出来的连续事件**追加**进去，会话直接恢复
    完整（会写入 `info` 日志说明补了多少条）。
  - **已经分叉**（后面的事件对不上，例如中间插入了新的"恢复"标记或别的命令）：**不拼**，
    因为把旧历史接在新事件之后会伪造出从未发生过的顺序。此时只记录一条明确警告并给出
    处理办法：`session "…" holds 49 of 1587 vaulted event(s) but diverged at seq 40, so
    it cannot be extended; delete this session in DSH and run /vault restore to rebuild it
    from the vault`，`/vault restore` 的回复里也会说明需要重建几个会话。
  - 为了不拖慢启动，启动时的比较以"存储产物远小于记录"为门槛（约 8 倍）；`/vault
    restore` 会强制逐个比较。
- **缺失的图片附件会被标记为"已卸载"。** 保险库镜像的是会话日志，**不含附件二进制**
  （图片按内容寻址存放在 `<DSH_HOME>/attachments/v1/objects/`）。会话被复制到另一台
  机器后，日志里的图片引用仍在、字节却不在，而宿主会在发请求前逐个读取这些图片——
  读取失败会以与文件无关的 `DeepSeek Messages transport failed` 形式报错，导致**每一轮
  都失败**。插件在会话打开时会检测这种缺失，并按 DSH 自己的机制追加一条
  `image/offload` 事件，把该图片替换为文本占位；对话随即恢复可用，缺的只是那几张图。
  重新打开会话（或重启应用）即可触发这次修复。

  > 这是已知边界：**图片/附件不随保险库迁移**。需要完整保留图片时，请把
  > `<DSH_HOME>/attachments/v1` 一并复制。
- **图片附件会先按"字节相同"从工作区找回，再考虑卸载。** 附件的 id 就是图片字节的
  sha256，所以工作区里任何一个**字节完全相同**的图片文件都"就是"那张图——路径和文件名
  都可以不同。恢复或打开会话时，插件会在工作区内扫描图片文件（限深度 6、上限 4000 个，
  先按大小筛选再逐一比哈希），命中就复制回附件库，原样恢复；只有确实找不到相同字节的
  图片才会被标记为"已卸载"。这意味着：把图片文件放进工作区（任意子目录、任意名字）再
  打开会话，就能把图找回来。

## 配置

保险库本身无需配置：插件以空 `config` 插入；保险库目录名（`dsh-session-vault`）
和 JSONL 格式是固定的，以保证不同机器之间的保险库可以互换。仅自动更新有三个可选
配置项（见「自动更新」）：`autoUpdate`、`updateCheckIntervalMs`、
`updateInitialDelayMs`。

每个保险库的 `workspace.json` 还带有 `kind: "dsh-vault"` 标记，因此插件按内容
识别保险库，而不只依赖目录名。

## 开发

```sh
# 语法检查
node --check lib/index.js
node --check lib/vault.js
node --check lib/self-update.js
```

插件是无第三方依赖的 ESM（`lib/index.js` + `lib/vault.js` + `lib/self-update.js`），
无需构建步骤；DSH 宿主包作为 peer 依赖。它导出 `apply`、`inject`、`name`，并由
bundle 层 `cordis.patch.yml` 插入到 profile 组合中。JSONL 格式是自包含的、独立于
harness，因此 `lib/vault.js` 可直接做单元测试。

## License

MIT
