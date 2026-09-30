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
github:XiaoWind/dsh-vault
```

桌面版会在 profile 目录里执行 `pnpm add github:XiaoWind/dsh-vault`，从 GitHub
拉取默认分支的最新 commit，校验通过后把本包加入 `dsh.profile.bundles`。
**安装后按提示重启桌面应用**才会生效。

> **必须使用 `github:owner/repo` 这种规格。** 本插件没有发布到 npm registry，
> 只写 `dsh-vault` 会去 npm 上查找，安装会失败。

> 桌面版在安装时会逐条校验本插件 `peerDependencies` 里的 `@deepseek-ai/dsh-*`
> 范围是否接受当前运行时版本（即 `dsh-app-boot` 的版本，例如 `0.2.0-rc.2`）。
> 不兼容时会拒绝安装，并回滚 `package.json`、`pnpm-lock.yaml` 和
> `node_modules`；遇到这种情况请更新到最新版插件。

### CLI / Web 版

```sh
# 从 GitHub 安装（立即可用，无需发布到 npm）
dsh plugin --profile web add github:XiaoWind/dsh-vault

# 等价写法
dsh plugin --profile web add git+https://github.com/XiaoWind/dsh-vault.git
```

`dsh plugin` 会把参数转发给 `web` profile 目录内的 `pnpm`，随后自动把该包加入
`dsh.profile.bundles` 层级列表（因为本包声明了 `dsh.bundle.patch`）。安装后请
重启 Web 应用。

> 本插件注入 `sessionPersistence`、`workspaceRegistry` 和 `commands` 服务，因此
> 只在包含这些 host 服务的 profile 中生效——官方自带的 `web` profile 就包含它们。

## 更新

**桌面版**：在插件管理里重新安装该插件，或先移除再按
`github:XiaoWind/dsh-vault` 重新添加。pnpm 可能缓存旧的 git 解析结果，移除后重新
添加最可靠；更新后重启桌面应用。

**CLI / Web 版**：

```sh
dsh plugin --profile web update dsh-vault
```

`dsh plugin` 会把参数转发给 profile 目录里的 `pnpm update dsh-vault`，把
`github:XiaoWind/dsh-vault` 重新解析到默认分支的最新 commit。锁文件按 commit
钉住 git 依赖，因此不必升级 `version` 也能更新。若 pnpm 因缓存没有拉到新
commit，可显式重新钉一次：

```sh
dsh plugin --profile web add github:XiaoWind/dsh-vault
```

更新后请重启应用——bundle 层在启动时组合，运行中的进程不会热更已安装的插件。

## 用法

保险库全自动运行，无需额外配置。提供了 `/vault` 斜杠命令用于查看和手动控制：

| 命令 | 作用 |
|---|---|
| `/vault status` | 查看已保险的工作区及每个工作区的会话数量。 |
| `/vault restore` | 立即为已知工作区导入保险库中的会话/标题。 |
| `/vault export` | 立即把当前持久化数据（重新）写入保险库文件。 |
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
- **记录会自动补全。** 插件只在自己运行期间镜像事件；如果某个会话在插件未加载时
  （切换运行时、重装插件等）继续追加事件，这一段就不会进入保险库文件。会话再次
  打开时，插件会比对文件与内存中的完整日志并补全文件；会话销毁时也会写入完整
  快照。`/vault export` 则按当前持久化数据强制重写全部保险库文件，可随时彻底修复。
- **不完整的记录不会被强行导入。** DSH 的持久化日志必须是 `seq` 从 0 开始、逐条
  连续的序列，所以缺少开头或中间有缺口的保险库记录无法被忠实还原。插件会跳过这种
  记录，并在日志里写明原因（例如 `its log starts at seq 6`），而不是导入一个看起来
  完整、实际被截断的会话。要修复，请在源机器的该工作区执行 `/vault export`，把记录
  补全后再复制。

## 配置

无需配置。插件以空 `config` 插入；保险库目录名（`dsh-session-vault`）和 JSONL
格式是固定的，以保证不同机器之间的保险库可以互换。

每个保险库的 `workspace.json` 还带有 `kind: "dsh-vault"` 标记，因此插件按内容
识别保险库，而不只依赖目录名。

## 开发

```sh
# 语法检查
node --check lib/index.js
node --check lib/vault.js
```

插件是无第三方依赖的 ESM（`lib/index.js` + `lib/vault.js`），无需构建步骤。它导出
`apply`、`inject`、`name`，并由 bundle 层 `cordis.patch.yml` 插入到 profile 组合中。
JSONL 格式是自包含的、独立于 harness，因此 `lib/vault.js` 可直接做单元测试。

## License

MIT
